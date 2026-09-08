import { readCurrentGitBranchName } from './git-current-branch'
import type { GitOperationSelector } from './git-operation-selector'
import type { GitUpstreamStatus } from './git-status-types'
import {
  getConfiguredBranchRemoteUpstream,
  hasConfiguredBranchPushTarget
} from './git-configured-branch-target'
import {
  gitTrackingRefDisplayName,
  gitUpstreamIdentity,
  projectGitUpstreamIdentity,
  type GitUpstreamStatusIdentity
} from './git-upstream-identity'
import { parseGitRevListAheadBehindCounts } from './git-rev-list-output'

export { gitRefTargetsBranchName, splitRemoteBranchName } from './git-remote-branch-name'

export type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

export type EffectiveGitUpstream =
  | {
      upstreamName: string
      upstreamRef: string
      remoteName: string | null
      branchName: string
      mergeRef: string
      isConfiguredUpstream: true
    }
  | {
      upstreamName: string | null
      upstreamRef: string | null
      remoteName: string
      branchName: string
      mergeRef: string
      isConfiguredUpstream: false
      operationSelector?: GitOperationSelector
    }

async function getConfiguredUpstream(
  runGit: GitCommandRunner,
  currentBranchName: string | null
): Promise<Extract<EffectiveGitUpstream, { isConfiguredUpstream: true }> | null> {
  if (!currentBranchName) {
    return null
  }
  const { stdout } = await runGit([
    'for-each-ref',
    '--format=%(upstream)%00%(upstream:trackshort)%00%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)',
    `refs/heads/${currentBranchName}`
  ])
  const [upstreamRef, tracking, refName, remote, mergeRef] = stdout.trim().split('\0')
  if (refName !== `refs/heads/${currentBranchName}` || !tracking || !upstreamRef || !remote) {
    return null
  }
  const identity = gitUpstreamIdentity(
    remote === '.' ? { kind: 'local', value: '.' } : { kind: 'named-remote', value: remote },
    mergeRef,
    upstreamRef
  )
  if (!identity) {
    return null
  }
  return {
    upstreamName: gitTrackingRefDisplayName(upstreamRef),
    upstreamRef,
    remoteName: identity.selector.kind === 'local' ? null : identity.selector.value,
    branchName: identity.branchName,
    mergeRef: identity.mergeRef,
    isConfiguredUpstream: true
  }
}

async function remoteTrackingRefExists(
  runGit: GitCommandRunner,
  remoteName: string,
  branchName: string
): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteName}/${branchName}`])
    return true
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 1) {
      return false
    }
    throw error
  }
}

async function resolveEffectiveGitUpstreamForBranch(
  runGit: GitCommandRunner,
  currentBranchName: string | null
): Promise<EffectiveGitUpstream | null> {
  const configured = await getConfiguredUpstream(runGit, currentBranchName)

  if (configured) {
    if (!currentBranchName || configured.branchName === currentBranchName) {
      return configured
    }

    // Why: older Orca worktrees inherited origin/main as their upstream even
    // though pushes target origin/<current-branch>. If that same-name remote
    // exists, source-control pull/sync must follow the publish branch rather
    // than the base branch.
    if (
      configured.remoteName === 'origin' &&
      (await remoteTrackingRefExists(runGit, configured.remoteName, currentBranchName))
    ) {
      return {
        upstreamName: `${configured.remoteName}/${currentBranchName}`,
        upstreamRef: `refs/remotes/${configured.remoteName}/${currentBranchName}`,
        remoteName: configured.remoteName,
        branchName: currentBranchName,
        mergeRef: `refs/heads/${currentBranchName}`,
        isConfiguredUpstream: false
      }
    }

    return configured
  }

  if (currentBranchName) {
    const branchRemoteUpstream = await getConfiguredBranchRemoteUpstream(
      runGit,
      currentBranchName,
      (remoteName, branchName) => remoteTrackingRefExists(runGit, remoteName, branchName)
    )
    if (branchRemoteUpstream) {
      // Why: Git cannot resolve HEAD@{u} when branch.<name>.remote is a URL,
      // but older fork-review worktrees still carry the usable merge target.
      return branchRemoteUpstream
    }
  }

  if (currentBranchName && (await remoteTrackingRefExists(runGit, 'origin', currentBranchName))) {
    return {
      upstreamName: `origin/${currentBranchName}`,
      upstreamRef: `refs/remotes/origin/${currentBranchName}`,
      remoteName: 'origin',
      branchName: currentBranchName,
      mergeRef: `refs/heads/${currentBranchName}`,
      isConfiguredUpstream: false
    }
  }

  return null
}

export async function resolveEffectiveGitUpstream(
  runGit: GitCommandRunner
): Promise<EffectiveGitUpstream | null> {
  return resolveEffectiveGitUpstreamForBranch(runGit, await readCurrentGitBranchName(runGit))
}

export async function getEffectiveGitUpstreamStatus(
  runGit: GitCommandRunner,
  getBehindCommitsArePatchEquivalent?: (upstreamName: string) => Promise<boolean>
): Promise<GitUpstreamStatus> {
  const currentBranchName = await readCurrentGitBranchName(runGit)
  const upstream = await resolveEffectiveGitUpstreamForBranch(runGit, currentBranchName)
  const upstreamIdentity = upstream
    ? projectGitUpstreamIdentity({
        selector:
          !upstream.isConfiguredUpstream && upstream.operationSelector
            ? upstream.operationSelector
            : upstream.remoteName === null
              ? { kind: 'local', value: '.' }
              : { kind: 'named-remote', value: upstream.remoteName },
        mergeRef: upstream.mergeRef,
        branchName: upstream.branchName,
        trackingRef: upstream.upstreamRef
      })
    : undefined
  if (!upstream?.upstreamRef || !upstreamIdentity) {
    const hasConfiguredPushTarget = currentBranchName
      ? await hasConfiguredBranchPushTarget(runGit, currentBranchName)
      : false
    return {
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      ...(upstreamIdentity ? { upstreamIdentity } : {}),
      ...(hasConfiguredPushTarget ? { hasConfiguredPushTarget: true } : {})
    }
  }

  return getGitUpstreamStatusForIdentity(
    runGit,
    { ...upstreamIdentity, trackingRef: upstream.upstreamRef },
    getBehindCommitsArePatchEquivalent
  )
}

// Refresh counts from the same resolved identity retained by the host cache.
export async function getGitUpstreamStatusForIdentity(
  runGit: GitCommandRunner,
  upstreamIdentity: GitUpstreamStatusIdentity & { trackingRef: string },
  getBehindCommitsArePatchEquivalent?: (upstreamRef: string) => Promise<boolean>
): Promise<GitUpstreamStatus> {
  const upstreamRef = upstreamIdentity.trackingRef
  const upstreamName = gitTrackingRefDisplayName(upstreamRef)
  const { stdout } = await runGit(['rev-list', '--left-right', '--count', `HEAD...${upstreamRef}`])
  const counts = parseGitRevListAheadBehindCounts(stdout)
  if (counts.status === 'unexpected-field-count') {
    throw new Error(`Unexpected git rev-list output: ${JSON.stringify(stdout)}`)
  }
  if (counts.status === 'unparseable-counts') {
    throw new Error(`Unparseable git rev-list counts: ${JSON.stringify(stdout)}`)
  }

  const behindCommitsArePatchEquivalent =
    counts.ahead > 0 && counts.behind > 0 && getBehindCommitsArePatchEquivalent
      ? await getBehindCommitsArePatchEquivalent(upstreamRef)
      : undefined

  return {
    hasUpstream: true,
    upstreamName,
    upstreamIdentity,
    ahead: counts.ahead,
    behind: counts.behind,
    ...(behindCommitsArePatchEquivalent !== undefined ? { behindCommitsArePatchEquivalent } : {})
  }
}
