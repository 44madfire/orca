import { gitRefTargetsBranchOnRemote } from '../../shared/git-remote-branch-name'
import type { GitAdmissionTier } from './command-runner/git-exec-options'
import {
  _resetGitRemoteTopologySnapshotCache,
  getGitRemoteTopologySnapshot,
  type GitRemoteTopologySnapshot
} from './git-remote-topology-snapshot'

export type GitRemoteRoleResolution =
  | { kind: 'resolved'; remoteName: string; provenance: GitRemoteRoleProvenance }
  | { kind: 'ambiguous'; remoteNames: string[]; provenance: GitRemoteRoleProvenance }
  | { kind: 'unresolved' }

export type GitRemoteRoleProvenance =
  | 'branch-push-remote'
  | 'remote-push-default'
  | 'configured-upstream'
  | 'matching-remote-branch'
  | 'persisted-exact-remote'
  | 'conventional-upstream'
  | 'conventional-origin'
  | 'sole-provider-remote'

export type GitOperationRemoteRoles = {
  head: GitRemoteRoleResolution
  issueSource: GitRemoteRoleResolution
  reviewBase:
    | { kind: 'candidates'; remoteNames: string[]; provenance: 'provider-authenticated' }
    | { kind: 'unresolved' }
}

function configuredRemote(snapshot: GitRemoteTopologySnapshot, key: string): string | null {
  const value = snapshot.config.get(key.toLowerCase())?.trim()
  return value && snapshot.remoteNames.includes(value) ? value : null
}

function configuredUpstreamRemote(
  snapshot: GitRemoteTopologySnapshot,
  branchName: string
): string | null {
  const remoteName = configuredRemote(snapshot, `branch.${branchName}.remote`)
  const mergeRef = snapshot.config.get(`branch.${branchName}.merge`.toLowerCase())?.trim()
  const mergeBranchName = mergeRef?.replace(/^refs\/heads\//, '')
  if (!remoteName || !mergeBranchName || mergeBranchName === mergeRef) {
    return null
  }
  const baseRef = snapshot.config.get(`branch.${branchName}.base`.toLowerCase())
  return gitRefTargetsBranchOnRemote(baseRef, remoteName, mergeBranchName) ? null : remoteName
}

function resolveHeadRole(
  snapshot: GitRemoteTopologySnapshot,
  branchName: string,
  eligibleRemotes: readonly string[],
  persistedExactRemoteName?: string
): GitRemoteRoleResolution {
  const pushRemote = configuredRemote(snapshot, `branch.${branchName}.pushRemote`)
  if (pushRemote && eligibleRemotes.includes(pushRemote)) {
    return { kind: 'resolved', remoteName: pushRemote, provenance: 'branch-push-remote' }
  }
  const pushDefault = configuredRemote(snapshot, 'remote.pushDefault')
  if (pushDefault && eligibleRemotes.includes(pushDefault)) {
    return { kind: 'resolved', remoteName: pushDefault, provenance: 'remote-push-default' }
  }
  const upstream = configuredUpstreamRemote(snapshot, branchName)
  if (upstream && eligibleRemotes.includes(upstream)) {
    return { kind: 'resolved', remoteName: upstream, provenance: 'configured-upstream' }
  }
  const localOid = snapshot.localBranchOids.get(branchName)
  const matching = localOid
    ? eligibleRemotes.filter(
        (remote) => snapshot.remoteBranchOids.get(`${remote}/${branchName}`) === localOid
      )
    : []
  if (matching.length === 1) {
    return { kind: 'resolved', remoteName: matching[0]!, provenance: 'matching-remote-branch' }
  }
  if (matching.length > 1) {
    return { kind: 'ambiguous', remoteNames: matching, provenance: 'matching-remote-branch' }
  }
  if (persistedExactRemoteName && eligibleRemotes.includes(persistedExactRemoteName)) {
    return {
      kind: 'resolved',
      remoteName: persistedExactRemoteName,
      provenance: 'persisted-exact-remote'
    }
  }
  if (eligibleRemotes.length === 1) {
    return {
      kind: 'resolved',
      remoteName: eligibleRemotes[0]!,
      provenance: 'sole-provider-remote'
    }
  }
  return eligibleRemotes.length > 1
    ? { kind: 'ambiguous', remoteNames: [...eligibleRemotes], provenance: 'sole-provider-remote' }
    : { kind: 'unresolved' }
}

function resolveIssueSourceRole(
  eligibleRemotes: readonly string[],
  persistedExactRemoteName?: string
): GitRemoteRoleResolution {
  if (eligibleRemotes.includes('upstream')) {
    return { kind: 'resolved', remoteName: 'upstream', provenance: 'conventional-upstream' }
  }
  if (eligibleRemotes.includes('origin')) {
    return { kind: 'resolved', remoteName: 'origin', provenance: 'conventional-origin' }
  }
  if (persistedExactRemoteName && eligibleRemotes.includes(persistedExactRemoteName)) {
    return {
      kind: 'resolved',
      remoteName: persistedExactRemoteName,
      provenance: 'persisted-exact-remote'
    }
  }
  if (eligibleRemotes.length === 1) {
    return {
      kind: 'resolved',
      remoteName: eligibleRemotes[0]!,
      provenance: 'sole-provider-remote'
    }
  }
  return eligibleRemotes.length > 1
    ? { kind: 'ambiguous', remoteNames: [...eligibleRemotes], provenance: 'sole-provider-remote' }
    : { kind: 'unresolved' }
}

function reviewBaseRole(eligibleRemotes: readonly string[]): GitOperationRemoteRoles['reviewBase'] {
  const rank = (remoteName: string): number => {
    if (remoteName === 'upstream') {
      return 0
    }
    if (remoteName === 'origin') {
      return 1
    }
    return 2
  }
  const remoteNames = [...eligibleRemotes].sort((left, right) => rank(left) - rank(right))
  return remoteNames.length > 0
    ? { kind: 'candidates', remoteNames, provenance: 'provider-authenticated' }
    : { kind: 'unresolved' }
}

export async function resolveGitOperationRemoteRoles(args: {
  repoPath: string
  branchName: string
  eligibleRemotes: (remoteNames: readonly string[]) => Promise<readonly string[]>
  connectionId?: string | null
  localGitOptions?: { wslDistro?: string; admissionTier?: GitAdmissionTier }
  providerAuthInventory?: string
  persistedExactRemoteName?: string
}): Promise<GitOperationRemoteRoles> {
  const snapshot = await getGitRemoteTopologySnapshot(args)
  const eligibleRemotes = await args.eligibleRemotes(snapshot.remoteNames)
  return {
    head: resolveHeadRole(
      snapshot,
      args.branchName,
      eligibleRemotes,
      args.persistedExactRemoteName
    ),
    issueSource: resolveIssueSourceRole(eligibleRemotes, args.persistedExactRemoteName),
    reviewBase: reviewBaseRole(eligibleRemotes)
  }
}

/** @internal */
export function _resetGitOperationRemoteRoleCache(): void {
  _resetGitRemoteTopologySnapshotCache()
}
