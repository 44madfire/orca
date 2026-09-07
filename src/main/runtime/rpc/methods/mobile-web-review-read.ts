import {
  MobileWebProviderReviewPayloadSchema,
  MobileWebProviderReviewResultSchema
} from '../../../../shared/mobile-web/provider-review-contract'
import { defineMethod } from '../core'
import {
  assertMobileWebReviewIdentity,
  MobileWebReviewScope,
  mobileWebReviewPayload,
  mobileWebReviewRepoSelector,
  mobileWebReviewResult,
  readMobileWebReviewDetails,
  readMobileWebReviewSummary
} from './mobile-web-review-scope'
import { projectMobileWebReviewDetails } from './mobile-web-review-projection'

export const MOBILE_WEB_REVIEW_READ_METHOD = defineMethod({
  name: 'mobileWeb.review.read',
  params: MobileWebReviewScope.passthrough(),
  handler: async (params, context) => {
    const payload = mobileWebReviewPayload(MobileWebProviderReviewPayloadSchema, params)
    const identity = { ...payload, worktree: params.worktree }
    await assertMobileWebReviewIdentity(context, identity)
    const repo = mobileWebReviewRepoSelector(params.worktree)
    const summary = await readMobileWebReviewSummary(context, repo, identity)
    const details = summary ? await readMobileWebReviewDetails(context, repo, summary) : null
    return mobileWebReviewResult(
      MobileWebProviderReviewResultSchema.parse({
        workspaceId: payload.workspaceId,
        observedHead: payload.expectedHead,
        branch: payload.expectedBranch,
        review: summary ? projectMobileWebReviewDetails(summary, details) : null
      })
    )
  }
})
