import { parseGitRemoteFetchUrls } from '../../shared/git-remote-url-index'
import { readLocalGitConfigSignature } from '../github/local-git-config-signature'
import {
  getSshGitProvider,
  getSshGitProviderGeneration,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import type { GitAdmissionTier } from './command-runner/git-exec-options'
import { gitExecFileAsync } from './runner'

export type GitRemoteTopologySnapshot = {
  config: Map<string, string>
  localBranchOids: Map<string, string>
  remoteBranchOids: Map<string, string>
  remoteNames: string[]
}

type LocalGitOptions = { wslDistro?: string; admissionTier?: GitAdmissionTier }
type CachedSnapshot = {
  expiresAt: number
  configSignature?: string
  snapshot: GitRemoteTopologySnapshot
}

const SNAPSHOT_TTL_MS = 30_000
const SNAPSHOT_CACHE_MAX_ENTRIES = 512
const SNAPSHOT_MAX_REMOTES = 128
const SNAPSHOT_MAX_REFS = 4_096
const snapshotCache = new Map<string, CachedSnapshot>()
const snapshotInFlight = new Map<string, Promise<GitRemoteTopologySnapshot>>()

function runtimeKey(connectionId?: string | null, options: LocalGitOptions = {}): string {
  return connectionId
    ? `ssh:${connectionId}:${getSshGitProviderGeneration(connectionId)}`
    : `local:${options.wslDistro ?? 'host'}`
}

function pruneSnapshotCache(now: number): void {
  for (const [key, entry] of snapshotCache) {
    if (entry.expiresAt <= now) {
      snapshotCache.delete(key)
    }
  }
  while (snapshotCache.size > SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldest = snapshotCache.keys().next().value
    if (oldest === undefined) {
      return
    }
    snapshotCache.delete(oldest)
  }
}

function parseConfigSnapshot(stdout: string): Map<string, string> {
  const config = new Map<string, string>()
  for (const record of stdout.split('\0')) {
    const separator = record.indexOf('\n')
    if (separator !== -1) {
      config.set(record.slice(0, separator).toLowerCase(), record.slice(separator + 1))
    }
  }
  return config
}

function parseRefSnapshot(
  stdout: string
): Pick<GitRemoteTopologySnapshot, 'localBranchOids' | 'remoteBranchOids'> {
  const localBranchOids = new Map<string, string>()
  const remoteBranchOids = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const [refName, oid] = line.split('\0')
    if (!refName || !oid) {
      continue
    }
    if (refName.startsWith('refs/heads/')) {
      localBranchOids.set(refName.slice('refs/heads/'.length), oid)
    } else if (refName.startsWith('refs/remotes/')) {
      remoteBranchOids.set(refName.slice('refs/remotes/'.length), oid)
    }
  }
  return { localBranchOids, remoteBranchOids }
}

async function probeSnapshot(
  repoPath: string,
  connectionId?: string | null,
  options: LocalGitOptions = {}
): Promise<GitRemoteTopologySnapshot> {
  const provider = connectionId ? getSshGitProvider(connectionId) : null
  if (connectionId && !provider) {
    throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  const runGit = async (args: string[]): Promise<{ stdout: string }> => {
    if (provider) {
      return provider.exec(args, repoPath)
    }
    return gitExecFileAsync(args, {
      cwd: repoPath,
      ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
      ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
    })
  }
  const [remoteResult, configResult, refResult] = await Promise.all([
    runGit(['remote', '-v']),
    runGit(['config', '--list', '-z']),
    runGit([
      'for-each-ref',
      `--count=${SNAPSHOT_MAX_REFS + 1}`,
      '--format=%(refname)%00%(objectname)',
      'refs/heads',
      'refs/remotes'
    ])
  ])
  const refs = parseRefSnapshot(refResult.stdout)
  if (refs.localBranchOids.size + refs.remoteBranchOids.size > SNAPSHOT_MAX_REFS) {
    throw new Error('Git remote topology has too many refs to resolve safely.')
  }
  const remoteNames = [...parseGitRemoteFetchUrls(remoteResult.stdout).keys()]
  if (remoteNames.length > SNAPSHOT_MAX_REMOTES) {
    throw new Error('Git remote topology has too many remotes to resolve safely.')
  }
  return { config: parseConfigSnapshot(configResult.stdout), ...refs, remoteNames }
}

async function loadSnapshot(
  key: string,
  repoPath: string,
  connectionId?: string | null,
  options: LocalGitOptions = {}
): Promise<GitRemoteTopologySnapshot> {
  const now = Date.now()
  pruneSnapshotCache(now)
  const cached = snapshotCache.get(key)
  if (cached && cached.expiresAt > now) {
    if (!cached.configSignature) {
      return cached.snapshot
    }
    const currentSignature = await readLocalGitConfigSignature({
      repoPath,
      connectionId: connectionId ?? null,
      ...options
    })
    if (currentSignature === cached.configSignature) {
      return cached.snapshot
    }
    snapshotCache.delete(key)
  }
  const startingSignature = await readLocalGitConfigSignature({
    repoPath,
    connectionId: connectionId ?? null,
    ...options
  })
  const snapshot = await probeSnapshot(repoPath, connectionId, options)
  const endingSignature = await readLocalGitConfigSignature({
    repoPath,
    connectionId: connectionId ?? null,
    ...options
  })
  if (startingSignature === endingSignature) {
    snapshotCache.set(key, {
      snapshot,
      expiresAt: Date.now() + SNAPSHOT_TTL_MS,
      ...(endingSignature ? { configSignature: endingSignature } : {})
    })
    pruneSnapshotCache(Date.now())
  }
  return snapshot
}

export async function getGitRemoteTopologySnapshot(args: {
  repoPath: string
  connectionId?: string | null
  localGitOptions?: LocalGitOptions
  providerAuthInventory?: string
}): Promise<GitRemoteTopologySnapshot> {
  const key = [
    runtimeKey(args.connectionId, args.localGitOptions),
    args.repoPath,
    args.providerAuthInventory ?? ''
  ].join('\0')
  const inFlight = snapshotInFlight.get(key)
  if (inFlight) {
    return inFlight
  }
  const probe = loadSnapshot(key, args.repoPath, args.connectionId, args.localGitOptions)
  snapshotInFlight.set(key, probe)
  try {
    return await probe
  } finally {
    if (snapshotInFlight.get(key) === probe) {
      snapshotInFlight.delete(key)
    }
  }
}

/** @internal */
export function _resetGitRemoteTopologySnapshotCache(): void {
  snapshotCache.clear()
  snapshotInFlight.clear()
}
