import type { GitUpstreamStatus } from './git-status-types'
import type { GitPushTarget } from './worktree/types'

export function hasUsableHostedReviewPushTarget(args: {
  pushTarget?: GitPushTarget
  upstreamStatus?: GitUpstreamStatus
  hasResolvableHostedReviewPushTargetLink?: boolean
  branchName?: string
}): boolean {
  const identity = args.upstreamStatus?.upstreamIdentity
  if (args.pushTarget) {
    return (
      args.upstreamStatus === undefined ||
      (identity?.selector.kind === 'named-remote' &&
        identity.selector.value === args.pushTarget.remoteName &&
        identity.mergeRef === `refs/heads/${args.pushTarget.branchName}`)
    )
  }
  if (args.hasResolvableHostedReviewPushTargetLink) {
    // Older peers supply only a label; wait for authoritative target metadata.
    return (
      args.upstreamStatus?.hasUpstream === true &&
      args.branchName !== undefined &&
      identity?.mergeRef === `refs/heads/${args.branchName}`
    )
  }
  return args.upstreamStatus?.hasConfiguredPushTarget === true
}
