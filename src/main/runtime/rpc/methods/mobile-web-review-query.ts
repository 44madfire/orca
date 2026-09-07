import {
  MobileWebProviderReviewQueryPayloadSchema,
  MobileWebProviderReviewQueryResultSchema,
  type MobileWebProviderReviewQueryPayload
} from '../../../../shared/mobile-web/provider-review-query-contract'
import type { MobileWebProviderReview } from '../../../../shared/mobile-web/provider-review-contract'
import { defineMethod, type RpcContext } from '../core'
import { projectMobileWebReviewDetails } from './mobile-web-review-projection'
import { clipMobileWebReviewCheckDetails } from './mobile-web-review-check-details'
import {
  callMobileWebReviewSource,
  isRecord,
  MobileWebReviewScope,
  mobileWebReviewPayload,
  mobileWebReviewResult,
  readMobileWebReviewTarget
} from './mobile-web-review-scope'
import { gitHubReviewTarget } from './mobile-web-review-targets'
import { reviewBoundedString } from './mobile-web-review-value-bounds'

/** Reads that only make sense once a review is on screen: who may be assigned to it, and the log
 *  of one of its checks. */
export const MOBILE_WEB_REVIEW_QUERY_METHOD = defineMethod({
  name: 'mobileWeb.review.query',
  params: MobileWebReviewScope.passthrough(),
  handler: async (params, context) => {
    const payload = mobileWebReviewPayload(MobileWebProviderReviewQueryPayloadSchema, params)
    const { repo, summary, details } = await readMobileWebReviewTarget(context, {
      ...payload,
      worktree: params.worktree
    })
    const review = projectMobileWebReviewDetails(summary, details)
    if (review.detailsState !== 'loaded' || review.provider !== 'github') {
      throw new Error('unsupported_provider')
    }
    return mobileWebReviewResult(
      MobileWebProviderReviewQueryResultSchema.parse(
        payload.query === 'assignableUsers'
          ? await queryAssignableUsers(context, repo, payload)
          : await queryCheckDetails(context, repo, payload, review, details)
      )
    )
  }
})

async function queryAssignableUsers(
  context: RpcContext,
  repo: string,
  payload: Extract<MobileWebProviderReviewQueryPayload, { query: 'assignableUsers' }>
) {
  const result = await callMobileWebReviewSource('github.listAssignableUsers', { repo }, context)
  if (!Array.isArray(result)) {
    throw new Error('host_error')
  }
  return {
    workspaceId: payload.workspaceId,
    provider: payload.provider,
    reviewNumber: payload.reviewNumber,
    query: payload.query,
    users: result.flatMap((value) => {
      if (!isRecord(value) || !reviewBoundedString(value.login, 80)) {
        return []
      }
      return [
        {
          login: reviewBoundedString(value.login, 80),
          name: reviewBoundedString(value.name, 160) || null
        }
      ]
    })
  }
}

async function queryCheckDetails(
  context: RpcContext,
  repo: string,
  payload: Extract<MobileWebProviderReviewQueryPayload, { query: 'checkDetails' }>,
  review: MobileWebProviderReview,
  details: unknown
) {
  const check = review.checks.find(
    (candidate) =>
      candidate.name === payload.checkName &&
      candidate.checkRunId === payload.checkRunId &&
      candidate.workflowRunId === payload.workflowRunId
  )
  if (!check) {
    throw new Error('conflict')
  }
  const result = await callMobileWebReviewSource(
    'github.prCheckDetails',
    {
      repo,
      checkName: check.name,
      ...(check.checkRunId ? { checkRunId: check.checkRunId } : {}),
      ...(check.workflowRunId ? { workflowRunId: check.workflowRunId } : {}),
      ...gitHubReviewTarget(details)
    },
    context
  )
  return {
    workspaceId: payload.workspaceId,
    provider: payload.provider,
    reviewNumber: payload.reviewNumber,
    query: payload.query,
    details: clipMobileWebReviewCheckDetails(result)
  }
}
