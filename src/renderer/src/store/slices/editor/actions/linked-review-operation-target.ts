import { isPositiveHostedReviewNumber } from '../../../../../../shared/hosted-review'
import type { GitPushTarget, Worktree } from '../../../../../../shared/worktree/types'

export function linkedReviewOperationTarget(
  worktree: Worktree | undefined,
  requested: GitPushTarget | undefined,
  fallbackGitHubPR?: number
): GitPushTarget | undefined {
  if (
    !isPositiveHostedReviewNumber(worktree?.linkedPR) &&
    !isPositiveHostedReviewNumber(worktree?.linkedGitLabMR) &&
    !isPositiveHostedReviewNumber(fallbackGitHubPR)
  ) {
    return requested
  }
  const resolved = worktree?.pushTarget
  if (!resolved) {
    throw new Error('The linked review push target is still unresolved. Retry after it loads.')
  }
  if (
    requested &&
    (requested.remoteName !== resolved.remoteName ||
      requested.branchName !== resolved.branchName ||
      requested.remoteUrl !== resolved.remoteUrl)
  ) {
    throw new Error('The linked review push target changed. Retry with the current target.')
  }
  return resolved
}
