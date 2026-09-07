import {
  MobileWebProviderReviewCreatePayloadSchema,
  MobileWebProviderReviewCreateResultSchema,
  MobileWebProviderReviewEligibilityPayloadSchema,
  MobileWebProviderReviewEligibilityResultSchema,
  MobileWebProviderReviewFieldsPayloadSchema,
  MobileWebProviderReviewFieldsResultSchema
} from '../../../../shared/mobile-web/provider-review-creation-contract'
import { defineMethod, type RpcContext } from '../core'
import {
  assertMobileWebReviewIdentity,
  callMobileWebReviewSource,
  isRecord,
  MobileWebReviewScope,
  mobileWebReviewPayload,
  mobileWebReviewRepoSelector,
  mobileWebReviewResult
} from './mobile-web-review-scope'
import { readMobileWebReviewCreationSnapshot } from './mobile-web-review-creation-snapshot'
import {
  clipMobileWebReviewCreateResult,
  clipMobileWebReviewEligibility,
  reviewBoundedText
} from './mobile-web-review-creation-clip'

const ELIGIBILITY_METHOD = defineMethod({
  name: 'mobileWeb.review.creationEligibility',
  params: MobileWebReviewScope.passthrough(),
  handler: async (params, context) => {
    const payload = mobileWebReviewPayload(MobileWebProviderReviewEligibilityPayloadSchema, params)
    return mobileWebReviewResult(await readEligibility(context, params.worktree, payload))
  }
})

const CREATE_METHOD = defineMethod({
  name: 'mobileWeb.review.create',
  params: MobileWebReviewScope.passthrough(),
  handler: async (params, context) => {
    const payload = mobileWebReviewPayload(MobileWebProviderReviewCreatePayloadSchema, params)
    const eligibility = await readEligibility(context, params.worktree, payload)
    if (
      !eligibility.canCreate ||
      eligibility.reviewLookupOutcome !== 'not_found' ||
      eligibility.provider !== payload.provider
    ) {
      throw new Error('conflict')
    }
    // Re-read after the eligibility round trip: creating from a moved head is not what was asked.
    await assertMobileWebReviewIdentity(context, { ...payload, worktree: params.worktree })
    const result = await callMobileWebReviewSource(
      'hostedReview.create',
      {
        repo: mobileWebReviewRepoSelector(params.worktree),
        worktree: params.worktree,
        provider: payload.provider,
        base: payload.base,
        ...(payload.head ? { head: payload.head } : {}),
        title: payload.title,
        ...(payload.body ? { body: payload.body } : {}),
        draft: payload.draft,
        ...(payload.useTemplate === undefined ? {} : { useTemplate: payload.useTemplate })
      },
      context
    )
    if (!isRecord(result)) {
      throw new Error('host_error')
    }
    return mobileWebReviewResult(
      MobileWebProviderReviewCreateResultSchema.parse({
        workspaceId: payload.workspaceId,
        provider: payload.provider,
        ...clipMobileWebReviewCreateResult(result)
      })
    )
  }
})

const GENERATE_FIELDS_METHOD = defineMethod({
  name: 'mobileWeb.review.generateFields',
  params: MobileWebReviewScope.passthrough(),
  handler: async (params, context) => {
    const payload = mobileWebReviewPayload(MobileWebProviderReviewFieldsPayloadSchema, params)
    await assertMobileWebReviewIdentity(context, { ...payload, worktree: params.worktree })
    const result = await callMobileWebReviewSource(
      'git.generatePullRequestFields',
      {
        worktree: params.worktree,
        base: payload.base,
        title: payload.title,
        body: payload.body,
        draft: payload.draft
      },
      context
    )
    if (!isRecord(result)) {
      throw new Error('host_error')
    }
    return mobileWebReviewResult(
      MobileWebProviderReviewFieldsResultSchema.parse(
        result.success === true && isRecord(result.fields)
          ? {
              workspaceId: payload.workspaceId,
              success: true,
              fields: {
                base: result.fields.base,
                title: reviewBoundedText(result.fields.title, 512),
                body: reviewBoundedText(result.fields.body, 32 * 1024),
                draft: result.fields.draft === true
              }
            }
          : {
              workspaceId: payload.workspaceId,
              success: false,
              error: reviewBoundedText(result.error, 1024)
            }
      )
    )
  }
})

/** What a creation call must name about the repository it was composed against. */
type ReviewCreationIdentity = {
  workspaceId: string
  expectedHead: string
  expectedBranch: string
  base?: string | null
}

async function readEligibility(
  context: RpcContext,
  worktree: string,
  payload: ReviewCreationIdentity
) {
  const snapshot = await readMobileWebReviewCreationSnapshot(context, worktree)
  if (snapshot.head !== payload.expectedHead || snapshot.branch !== payload.expectedBranch) {
    throw new Error('conflict')
  }
  const result = await callMobileWebReviewSource(
    'hostedReview.getCreationEligibility',
    {
      repo: mobileWebReviewRepoSelector(worktree),
      worktree,
      branch: payload.expectedBranch,
      base: payload.base ?? null,
      hasUncommittedChanges: snapshot.hasUncommittedChanges,
      hasUpstream: snapshot.upstream.hasUpstream,
      ahead: snapshot.upstream.ahead,
      behind: snapshot.upstream.behind,
      ...snapshot.links
    },
    context
  )
  if (!isRecord(result)) {
    throw new Error('host_error')
  }
  return MobileWebProviderReviewEligibilityResultSchema.parse({
    workspaceId: payload.workspaceId,
    observedHead: payload.expectedHead,
    branch: payload.expectedBranch,
    ...clipMobileWebReviewEligibility(result)
  })
}

export const MOBILE_WEB_REVIEW_CREATION_METHODS = [
  ELIGIBILITY_METHOD,
  CREATE_METHOD,
  GENERATE_FIELDS_METHOD
]
