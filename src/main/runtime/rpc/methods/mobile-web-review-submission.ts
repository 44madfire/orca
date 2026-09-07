import type { HostedReviewSubmissionComment } from '../../../../shared/hosted-review-submission'
import type { MobileWebProviderReviewFile } from '../../../../shared/mobile-web/provider-review-contract'
import {
  MobileWebProviderReviewSubmissionPayloadSchema,
  MobileWebProviderReviewSubmissionResultSchema,
  type MobileWebProviderReviewQueuedComment,
  type MobileWebProviderReviewSubmissionPayload
} from '../../../../shared/mobile-web/provider-review-submission-contract'
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
import {
  gitHubReviewTarget,
  gitLabReviewPosition,
  gitLabReviewTarget
} from './mobile-web-review-targets'

/** Posts a whole queued review at once. The provider rejects a comment on a line its diff does not
 *  expose, so the queue is checked against the review's own commentable lines first. */
export const MOBILE_WEB_REVIEW_SUBMIT_METHOD = defineMethod({
  name: 'mobileWeb.review.submit',
  params: MobileWebReviewScope.passthrough(),
  handler: async (params, context) => {
    const payload = mobileWebReviewPayload(MobileWebProviderReviewSubmissionPayloadSchema, params)
    const identity = { ...payload, worktree: params.worktree }
    const { repo, summary, details } = await readMobileWebReviewTarget(context, identity)
    const review = projectMobileWebReviewDetails(summary, details)
    if (
      review.detailsState !== 'loaded' ||
      review.headSha !== payload.expectedReviewHead ||
      !review.allowedSubmissionActions.includes(payload.action)
    ) {
      throw new Error('conflict')
    }
    const comments = retainedComments(review.files, payload.comments)
    // Re-read after the provider round trips: a branch switch during them must not land a write.
    await assertMobileWebReviewIdentity(context, identity)
    const result = await submitReview(context, repo, payload, details, comments)
    if (
      !isRecord(result) ||
      result.ok !== true ||
      result.action !== payload.action ||
      result.submittedComments !== comments.length
    ) {
      throw new Error('host_error')
    }
    return mobileWebReviewResult(
      MobileWebProviderReviewSubmissionResultSchema.parse({
        workspaceId: payload.workspaceId,
        provider: payload.provider,
        reviewNumber: payload.reviewNumber,
        expectedReviewHead: payload.expectedReviewHead,
        submissionId: payload.submissionId,
        action: payload.action,
        submittedCommentIds: payload.comments.map((comment) => comment.id),
        outcome: 'completed'
      })
    )
  }
})

function retainedComments(
  files: readonly MobileWebProviderReviewFile[],
  comments: readonly MobileWebProviderReviewQueuedComment[]
): HostedReviewSubmissionComment[] {
  return comments.map((comment) => {
    const file = files.find((candidate) => candidate.path === comment.path)
    const startLine = comment.startLine ?? comment.line
    if (
      !file ||
      file.isBinary ||
      startLine > comment.line ||
      !file.commentableLines.includes(startLine) ||
      !file.commentableLines.includes(comment.line)
    ) {
      throw new Error('conflict')
    }
    return {
      body: comment.body,
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      line: comment.line,
      ...(comment.startLine ? { startLine: comment.startLine } : {})
    }
  })
}

async function submitReview(
  context: RpcContext,
  repo: string,
  payload: MobileWebProviderReviewSubmissionPayload,
  details: unknown,
  comments: HostedReviewSubmissionComment[]
): Promise<unknown> {
  if (payload.provider === 'github') {
    const repository = gitHubReviewTarget(details).prRepo
    if (!repository) {
      throw new Error('conflict')
    }
    return callMobileWebReviewSource(
      'hostedReview.submit',
      {
        repo,
        provider: 'github',
        number: payload.reviewNumber,
        expectedHead: payload.expectedReviewHead,
        action: payload.action,
        summary: payload.summary,
        comments,
        repository
      },
      context
    )
  }
  if (payload.provider === 'gitlab' && payload.action === 'comment') {
    const projectRef = gitLabReviewTarget(details).projectRef
    const position = gitLabReviewPosition(details, payload.expectedReviewHead)
    if (!projectRef || !position) {
      throw new Error('conflict')
    }
    return callMobileWebReviewSource(
      'hostedReview.submit',
      {
        repo,
        provider: 'gitlab',
        number: payload.reviewNumber,
        expectedHead: payload.expectedReviewHead,
        action: payload.action,
        summary: payload.summary,
        comments,
        projectRef,
        baseSha: position.baseSha,
        startSha: position.startSha
      },
      context
    )
  }
  throw new Error('unsupported_provider')
}
