import {
  MobileWebSourceControlRepositoryStateSchema,
  MobileWebSourceControlUpstreamSnapshotSchema,
  type MobileWebSourceControlRepositoryState,
  type MobileWebSourceControlUpstreamSnapshot
} from '../../../src/shared/mobile-web/source-control-sync-contract'
import { MobileWebGitRefNameSchema } from '../../../src/shared/mobile-web/source-control-history-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'

/** Hosted review creation reads the repository the same way the Source Control screens do, but it
 * still runs in the shell: the provider capability has not moved to the generic host lane. */
export function assertProviderReviewRepositoryIdentity(
  state: Pick<MobileWebSourceControlRepositoryState, 'head' | 'branch'>,
  expected: { expectedHead: string | null; expectedBranch: string | null }
): void {
  if (state.head !== expected.expectedHead || state.branch !== expected.expectedBranch) {
    throw new MobileWebBrokerError('conflict')
  }
}

export async function readProviderReviewRepositoryState(
  client: RpcClient,
  pageWorkspaceId: string,
  hostWorkspaceId: string
): Promise<MobileWebSourceControlRepositoryState> {
  const [statusResponse, upstreamResponse, baseRef] = await Promise.all([
    client.sendRequest('git.status', { worktree: `id:${hostWorkspaceId}` }),
    client.sendRequest('git.upstreamStatus', { worktree: `id:${hostWorkspaceId}` }),
    resolveProviderReviewBaseRef(client, hostWorkspaceId)
  ])
  if (!statusResponse.ok || !upstreamResponse.ok || !isRecord(statusResponse.result)) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebSourceControlRepositoryStateSchema.parse({
    workspaceId: pageWorkspaceId,
    head: safeHead(statusResponse.result.head),
    branch: safeBranch(statusResponse.result.branch),
    conflictOperation: safeConflictOperation(statusResponse.result.conflictOperation),
    baseRef,
    upstream: sanitizeProviderReviewUpstreamSnapshot(upstreamResponse.result)
  })
}

export async function readProviderReviewStatusIdentity(
  client: RpcClient,
  hostWorkspaceId: string
): Promise<Pick<MobileWebSourceControlRepositoryState, 'head' | 'branch' | 'conflictOperation'>> {
  const response = await client.sendRequest('git.status', {
    worktree: `id:${hostWorkspaceId}`
  })
  if (!response.ok || !isRecord(response.result)) {
    throw new MobileWebBrokerError('host_error')
  }
  return {
    head: safeHead(response.result.head),
    branch: safeBranch(response.result.branch),
    conflictOperation: safeConflictOperation(response.result.conflictOperation)
  }
}

function sanitizeProviderReviewUpstreamSnapshot(
  value: unknown
): MobileWebSourceControlUpstreamSnapshot {
  if (!isRecord(value)) {
    throw new MobileWebBrokerError('host_error')
  }
  const upstreamName = boundedString(value.upstreamName, 240)
  return MobileWebSourceControlUpstreamSnapshotSchema.parse({
    hasUpstream: value.hasUpstream === true,
    ...(upstreamName ? { upstreamName } : {}),
    ahead: safeNonnegativeInteger(value.ahead),
    behind: safeNonnegativeInteger(value.behind),
    hasConfiguredPushTarget: value.hasConfiguredPushTarget === true,
    behindCommitsArePatchEquivalent: value.behindCommitsArePatchEquivalent === true
  })
}

function safeHead(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) ? value : null
}

function safeBranch(value: unknown): string | null {
  const parsed = MobileWebGitRefNameSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function safeConflictOperation(value: unknown): 'merge' | 'rebase' | 'cherry-pick' | 'unknown' {
  return value === 'merge' || value === 'rebase' || value === 'cherry-pick' ? value : 'unknown'
}

function safeNonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, limit)
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function resolveProviderReviewBaseRef(
  client: RpcClient,
  hostWorkspaceId: string
): Promise<string | null> {
  const worktreeBaseRef = await readWorktreeBaseRef(client, hostWorkspaceId)
  if (worktreeBaseRef) {
    return worktreeBaseRef
  }
  const repoId = hostWorkspaceId.split('::', 1)[0]?.trim()
  if (!repoId) {
    return null
  }
  const repoBaseRef = await readRepositoryBaseRef(client, repoId)
  if (repoBaseRef) {
    return repoBaseRef
  }
  try {
    const response = await client.sendRequest('repo.baseRefDefault', { repo: `id:${repoId}` })
    return response.ok && isRecord(response.result)
      ? safeProviderBaseRef(response.result.defaultBaseRef)
      : null
  } catch {
    return null
  }
}

async function readWorktreeBaseRef(
  client: RpcClient,
  hostWorkspaceId: string
): Promise<string | null> {
  try {
    const response = await client.sendRequest('worktree.show', {
      worktree: `id:${hostWorkspaceId}`
    })
    return response.ok && isRecord(response.result) && isRecord(response.result.worktree)
      ? safeProviderBaseRef(response.result.worktree.baseRef)
      : null
  } catch {
    return null
  }
}

async function readRepositoryBaseRef(client: RpcClient, repoId: string): Promise<string | null> {
  try {
    const response = await client.sendRequest('repo.list')
    if (!response.ok || !isRecord(response.result) || !Array.isArray(response.result.repos)) {
      return null
    }
    for (const candidate of response.result.repos) {
      if (isRecord(candidate) && candidate.id === repoId) {
        return safeProviderBaseRef(candidate.worktreeBaseRef)
      }
    }
  } catch {
    return null
  }
  return null
}

function safeProviderBaseRef(value: unknown): string | null {
  const parsed = MobileWebGitRefNameSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
