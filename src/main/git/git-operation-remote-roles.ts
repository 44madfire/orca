import { gitRefTargetsBranchOnRemote } from '../../shared/git-remote-branch-name'
import {
  gitOperationSelector,
  type GitOperationSelector
} from '../../shared/git-operation-selector'
import {
  normalizeGitConfigKey,
  type GitRemoteTopologySnapshot
} from './git-remote-topology-snapshot'

export type GitRemoteRoleResolution =
  | {
      kind: 'resolved'
      selector: GitOperationSelector
      provenance: GitRemoteRoleProvenance
    }
  | {
      kind: 'ambiguous'
      remoteNames: string[]
      provenance: GitRemoteRoleProvenance
    }
  | { kind: 'unresolved' }

export type GitRemoteRoleProvenance =
  | 'branch-push-remote'
  | 'remote-push-default'
  | 'configured-upstream'
  | 'matching-remote-branch'
  | 'persisted-exact-remote'
  | 'sole-provider-remote'

function configuredRemote(
  snapshot: GitRemoteTopologySnapshot,
  key: string
): GitOperationSelector | null {
  const value = snapshot.config.get(normalizeGitConfigKey(key))?.trim()
  if (!value) {
    return null
  }
  return gitOperationSelector(value, snapshot.remoteNames)
}

function configuredUpstreamRemote(
  snapshot: GitRemoteTopologySnapshot,
  branchName: string
): GitOperationSelector | null {
  const remoteName = configuredRemote(snapshot, `branch.${branchName}.remote`)
  const mergeRef = snapshot.config.get(normalizeGitConfigKey(`branch.${branchName}.merge`))?.trim()
  const mergeBranchName = mergeRef?.replace(/^refs\/heads\//, '')
  if (!remoteName || !mergeBranchName || mergeBranchName === mergeRef) {
    return null
  }
  const baseRef = snapshot.config.get(normalizeGitConfigKey(`branch.${branchName}.base`))
  return gitRefTargetsBranchOnRemote(baseRef, remoteName.value, mergeBranchName) ? null : remoteName
}

export function resolveHeadRole(
  snapshot: GitRemoteTopologySnapshot,
  branchName: string,
  eligibleRemotes: readonly string[],
  persistedExactRemoteName?: string
): GitRemoteRoleResolution {
  const pushRemote = configuredRemote(snapshot, `branch.${branchName}.pushRemote`)
  if (pushRemote) {
    return {
      kind: 'resolved',
      selector: pushRemote,
      provenance: 'branch-push-remote'
    }
  }
  const pushDefault = configuredRemote(snapshot, 'remote.pushDefault')
  if (pushDefault) {
    return {
      kind: 'resolved',
      selector: pushDefault,
      provenance: 'remote-push-default'
    }
  }
  const upstream = configuredUpstreamRemote(snapshot, branchName)
  if (upstream) {
    return {
      kind: 'resolved',
      selector: upstream,
      provenance: 'configured-upstream'
    }
  }
  const localOid = snapshot.localBranchOids.get(branchName)
  const matching = localOid
    ? eligibleRemotes.filter(
        (remote) => snapshot.remoteBranchOids.get(`${remote}/${branchName}`) === localOid
      )
    : []
  if (matching.length === 1) {
    return {
      kind: 'resolved',
      selector: gitOperationSelector(matching[0]!, snapshot.remoteNames),
      provenance: 'matching-remote-branch'
    }
  }
  if (matching.length > 1) {
    return {
      kind: 'ambiguous',
      remoteNames: matching,
      provenance: 'matching-remote-branch'
    }
  }
  if (persistedExactRemoteName && eligibleRemotes.includes(persistedExactRemoteName)) {
    return {
      kind: 'resolved',
      selector: { kind: 'named-remote', value: persistedExactRemoteName },
      provenance: 'persisted-exact-remote'
    }
  }
  if (eligibleRemotes.length === 1) {
    return {
      kind: 'resolved',
      selector: { kind: 'named-remote', value: eligibleRemotes[0]! },
      provenance: 'sole-provider-remote'
    }
  }
  return eligibleRemotes.length > 1
    ? {
        kind: 'ambiguous',
        remoteNames: [...eligibleRemotes],
        provenance: 'sole-provider-remote'
      }
    : { kind: 'unresolved' }
}

export function resolveIssueSourceRole(
  eligibleRemotes: readonly string[],
  persistedExactRemoteName?: string
): GitRemoteRoleResolution {
  if (persistedExactRemoteName && eligibleRemotes.includes(persistedExactRemoteName)) {
    return {
      kind: 'resolved',
      selector: { kind: 'named-remote', value: persistedExactRemoteName },
      provenance: 'persisted-exact-remote'
    }
  }
  if (eligibleRemotes.length === 1) {
    return {
      kind: 'resolved',
      selector: { kind: 'named-remote', value: eligibleRemotes[0]! },
      provenance: 'sole-provider-remote'
    }
  }
  return eligibleRemotes.length > 1
    ? {
        kind: 'ambiguous',
        remoteNames: [...eligibleRemotes],
        provenance: 'sole-provider-remote'
      }
    : { kind: 'unresolved' }
}

/** @internal */
export { _resetGitRemoteTopologySnapshotCache as _resetGitOperationRemoteRoleCache } from './git-remote-topology-snapshot'
