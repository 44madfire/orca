import {
  MobileWebProviderReviewManagementPayloadSchema,
  MobileWebProviderReviewManagementResultSchema,
  type MobileWebProviderReviewManagementPayload
} from '../../../../shared/mobile-web/provider-review-management-contract'
import type { MobileWebProviderReview } from '../../../../shared/mobile-web/provider-review-contract'
import { defineMethod, type RpcContext } from '../core'
import { projectMobileWebReviewDetails } from './mobile-web-review-projection'
import {
  assertMobileWebReviewIdentity,
  callMobileWebReviewSource,
  isRecord,
  MobileWebReviewScope,
  mobileWebReviewPayload,
  mobileWebReviewResult,
  readMobileWebReviewTarget
} from './mobile-web-review-scope'
import { gitHubReviewTarget } from './mobile-web-review-targets'
import { reviewPositiveIntegerString } from './mobile-web-review-value-bounds'

/** Merging, reviewer assignment and check reruns exist only on GitHub today; every other provider
 *  reaches this method with a review whose details never load. */
export const MOBILE_WEB_REVIEW_MANAGE_METHOD = defineMethod({
  name: 'mobileWeb.review.manage',
  params: MobileWebReviewScope.passthrough(),
  handler: async (params, context) => {
    const payload = mobileWebReviewPayload(MobileWebProviderReviewManagementPayloadSchema, params)
    const identity = { ...payload, worktree: params.worktree }
    const { repo, summary, details } = await readMobileWebReviewTarget(context, identity)
    const review = projectMobileWebReviewDetails(summary, details)
    if (review.detailsState !== 'loaded') {
      throw new Error('conflict')
    }
    if (review.provider !== 'github') {
      throw new Error('unsupported_provider')
    }
    // Re-read after the provider round trips: a branch switch during them must not land a write.
    await assertMobileWebReviewIdentity(context, identity)
    await manageGitHubReview(context, repo, payload, details, review)
    return mobileWebReviewResult(
      MobileWebProviderReviewManagementResultSchema.parse({
        workspaceId: payload.workspaceId,
        provider: payload.provider,
        reviewNumber: payload.reviewNumber,
        action: payload.action,
        outcome: 'completed'
      })
    )
  }
})

async function manageGitHubReview(
  context: RpcContext,
  repo: string,
  payload: MobileWebProviderReviewManagementPayload,
  details: unknown,
  review: MobileWebProviderReview
): Promise<void> {
  const target = gitHubReviewTarget(details)
  if (payload.action === 'merge') {
    return runMutation(context, 'github.mergePR', {
      repo,
      prNumber: payload.reviewNumber,
      ...(payload.method ? { method: payload.method } : {}),
      ...target
    })
  }
  if (payload.action === 'setAutoMerge') {
    return runMutation(context, 'github.setPRAutoMerge', {
      repo,
      prNumber: payload.reviewNumber,
      enabled: payload.enabled,
      ...(payload.method ? { method: payload.method } : {}),
      ...target
    })
  }
  if (payload.action === 'setState') {
    return runMutation(context, 'github.updatePRState', {
      repo,
      prNumber: payload.reviewNumber,
      updates: { state: payload.state },
      ...target
    })
  }
  if (payload.action === 'requestReviewers' || payload.action === 'removeReviewers') {
    await assertAssignableReviewers(context, repo, payload.reviewers)
    return runMutation(
      context,
      payload.action === 'requestReviewers'
        ? 'github.requestPRReviewers'
        : 'github.removePRReviewers',
      { repo, prNumber: payload.reviewNumber, reviewers: payload.reviewers, ...target }
    )
  }
  if (payload.action === 'rerunChecks') {
    if (payload.expectedReviewHead && payload.expectedReviewHead !== review.headSha) {
      throw new Error('conflict')
    }
    return runMutation(context, 'github.rerunPRChecks', {
      repo,
      prNumber: payload.reviewNumber,
      ...(review.headSha ? { headSha: review.headSha } : {}),
      ...(payload.failedOnly === undefined ? {} : { failedOnly: payload.failedOnly }),
      ...target
    })
  }
  if (payload.action === 'updateTitle') {
    return runMutation(context, 'github.updatePRTitle', {
      repo,
      prNumber: payload.reviewNumber,
      title: payload.title,
      ...target
    })
  }
  return mutateConversationComment(context, payload, target.prRepo, review)
}

/** The conversation-comment endpoints address the pull request's own repository slug, so a review
 *  whose details never named one cannot be edited. */
async function mutateConversationComment(
  context: RpcContext,
  payload: Extract<
    MobileWebProviderReviewManagementPayload,
    { action: 'updateConversationComment' | 'deleteConversationComment' }
  >,
  prRepo: Record<string, string> | undefined,
  review: MobileWebProviderReview
): Promise<void> {
  const comment = review.comments.find(
    (candidate) => candidate.id === payload.commentId && candidate.kind === 'conversation'
  )
  const commentId = reviewPositiveIntegerString(payload.commentId)
  if (!comment || commentId === null || !prRepo) {
    throw new Error('conflict')
  }
  return runMutation(
    context,
    payload.action === 'updateConversationComment'
      ? 'github.project.updateIssueCommentBySlug'
      : 'github.project.deleteIssueCommentBySlug',
    {
      ...prRepo,
      commentId,
      ...(payload.action === 'updateConversationComment' ? { body: payload.body } : {})
    }
  )
}

async function assertAssignableReviewers(
  context: RpcContext,
  repo: string,
  reviewers: string[]
): Promise<void> {
  const result = await callMobileWebReviewSource('github.listAssignableUsers', { repo }, context)
  if (!Array.isArray(result)) {
    throw new Error('host_error')
  }
  const assignable = new Set(
    result.flatMap((value) =>
      isRecord(value) && typeof value.login === 'string' ? [value.login.toLowerCase()] : []
    )
  )
  if (reviewers.some((reviewer) => !assignable.has(reviewer.toLowerCase()))) {
    throw new Error('conflict')
  }
}

async function runMutation(
  context: RpcContext,
  method: string,
  params: Record<string, unknown>
): Promise<void> {
  const result = await callMobileWebReviewSource(method, params, context)
  if (result !== true && (!isRecord(result) || result.ok !== true)) {
    throw new Error('host_error')
  }
}
