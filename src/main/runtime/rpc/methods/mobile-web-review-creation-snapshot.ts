import type { RpcContext } from '../core'
import { callMobileWebReviewSource, isRecord } from './mobile-web-review-scope'
import { reviewNonnegativeInteger, reviewPositiveInteger } from './mobile-web-review-value-bounds'

/** What the host needs before it can say whether a review can be opened for this branch: the
 *  working tree's cleanliness, its upstream distance, and any review already linked to it. */
export async function readMobileWebReviewCreationSnapshot(context: RpcContext, worktree: string) {
  const [status, upstream, worktreeShow] = await Promise.all([
    callMobileWebReviewSource('git.status', { worktree }, context),
    callMobileWebReviewSource('git.upstreamStatus', { worktree }, context),
    callMobileWebReviewSource('worktree.show', { worktree }, context)
  ])
  if (
    !isRecord(status) ||
    !Array.isArray(status.entries) ||
    !isRecord(upstream) ||
    !isRecord(worktreeShow) ||
    !isRecord(worktreeShow.worktree)
  ) {
    throw new Error('host_error')
  }
  const linked = worktreeShow.worktree
  return {
    head: status.head,
    branch: status.branch,
    hasUncommittedChanges: status.entries.length > 0,
    upstream: {
      hasUpstream: upstream.hasUpstream === true,
      ahead: reviewNonnegativeInteger(upstream.ahead),
      behind: reviewNonnegativeInteger(upstream.behind)
    },
    links: {
      linkedGitHubPR: reviewPositiveInteger(linked.linkedPR),
      linkedGitLabMR: reviewPositiveInteger(linked.linkedGitLabMR),
      linkedBitbucketPR: reviewPositiveInteger(linked.linkedBitbucketPR),
      linkedAzureDevOpsPR: reviewPositiveInteger(linked.linkedAzureDevOpsPR),
      linkedGiteaPR: reviewPositiveInteger(linked.linkedGiteaPR)
    }
  }
}
