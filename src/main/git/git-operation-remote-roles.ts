import { gitRefTargetsBranchOnRemote } from '../../shared/git-remote-branch-name'
import { normalizeConfiguredGitRemote } from '../../shared/git-remote-url-index'
import {
  normalizeGitConfigKey,
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
  | 'sole-provider-remote'

function configuredRemote(snapshot: GitRemoteTopologySnapshot, key: string): string | null {
  const value = snapshot.config.get(normalizeGitConfigKey(key))?.trim()
  if (!value) {
    return null
  }
  if (snapshot.remoteNames.includes(value)) {
    return value
  }
  const remote = normalizeConfiguredGitRemote(value, snapshot.fetchUrls)
  return snapshot.remoteNames.includes(remote) ? remote : null
}

function configuredUpstreamRemote(
  snapshot: GitRemoteTopologySnapshot,
  branchName: string
): string | null {
  const remoteName = configuredRemote(snapshot, `branch.${branchName}.remote`)
  const mergeRef = snapshot.config.get(normalizeGitConfigKey(`branch.${branchName}.merge`))?.trim()
  const mergeBranchName = mergeRef?.replace(/^refs\/heads\//, '')
  if (!remoteName || !mergeBranchName || mergeBranchName === mergeRef) {
    return null
  }
  const baseRef = snapshot.config.get(normalizeGitConfigKey(`branch.${branchName}.base`))
  return gitRefTargetsBranchOnRemote(baseRef, remoteName, mergeBranchName) ? null : remoteName
}

export function resolveHeadRole(
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

export function resolveIssueSourceRole(
  eligibleRemotes: readonly string[],
  persistedExactRemoteName?: string
): GitRemoteRoleResolution {
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

/** @internal */
export { _resetGitRemoteTopologySnapshotCache as _resetGitOperationRemoteRoleCache } from './git-remote-topology-snapshot'
