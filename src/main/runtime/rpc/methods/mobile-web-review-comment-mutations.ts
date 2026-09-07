import {
  MobileWebProviderReviewMutationPayloadSchema,
  MobileWebProviderReviewMutationResultSchema,
  type MobileWebProviderReview,
  type MobileWebProviderReviewMutationPayload,
  type MobileWebProviderReviewMutationResult
} from '../../../../shared/mobile-web/provider-review-contract'
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
  reviewInlinePosition,
  gitHubReviewTarget,
  gitLabReviewTarget
} from './mobile-web-review-targets'
import { reviewPositiveIntegerString } from './mobile-web-review-value-bounds'

export const MOBILE_WEB_REVIEW_COMMENT_METHOD = defineMethod({
  name: 'mobileWeb.review.comment',
  params: MobileWebReviewScope.passthrough(),
  handler: async (params, context) => {
    const payload = mobileWebReviewPayload(MobileWebProviderReviewMutationPayloadSchema, params)
    const identity = { ...payload, worktree: params.worktree }
    const { repo, summary, details } = await readMobileWebReviewTarget(context, identity)
    const review = projectMobileWebReviewDetails(summary, details)
    if (review.detailsState !== 'loaded') {
      throw new Error('conflict')
    }
    // Re-read after the provider round trips: a branch switch during them must not land a write.
    await assertMobileWebReviewIdentity(context, identity)
    await runReviewCommentMutation({ context, repo, payload, details, review })
    return mobileWebReviewResult(
      MobileWebProviderReviewMutationResultSchema.parse(mutationResult(payload))
    )
  }
})

async function runReviewCommentMutation(args: {
  context: RpcContext
  repo: string
  payload: MobileWebProviderReviewMutationPayload
  details: unknown
  review: MobileWebProviderReview
}): Promise<void> {
  if (args.payload.action === 'comment') {
    return addConversationComment(args.context, args.repo, args.payload, args.details)
  }
  if (args.payload.action === 'reply') {
    return replyToThread(args.context, args.repo, args.payload, args.details, args.review)
  }
  if (args.payload.action === 'inlineComment') {
    return addInlineComment(args.context, args.repo, args.payload, args.details, args.review)
  }
  return setThreadResolved(args.context, args.repo, args.payload, args.details, args.review)
}

async function addConversationComment(
  context: RpcContext,
  repo: string,
  payload: Extract<MobileWebProviderReviewMutationPayload, { action: 'comment' }>,
  details: unknown
): Promise<void> {
  if (payload.provider === 'github') {
    return assertCompleted(
      await callMobileWebReviewSource(
        'github.addIssueComment',
        { repo, number: payload.reviewNumber, body: payload.body, ...gitHubReviewTarget(details) },
        context
      )
    )
  }
  if (payload.provider === 'gitlab') {
    return assertCompleted(
      await callMobileWebReviewSource(
        'gitlab.addMRComment',
        { repo, iid: payload.reviewNumber, body: payload.body, ...gitLabReviewTarget(details) },
        context
      )
    )
  }
  throw new Error('unsupported_provider')
}

async function addInlineComment(
  context: RpcContext,
  repo: string,
  payload: Extract<MobileWebProviderReviewMutationPayload, { action: 'inlineComment' }>,
  details: unknown,
  review: MobileWebProviderReview
): Promise<void> {
  const file = review.files.find((candidate) => candidate.path === payload.path)
  const startLine = payload.startLine ?? payload.line
  if (
    !file ||
    review.headSha !== payload.expectedReviewHead ||
    startLine > payload.line ||
    !file.commentableLines.includes(startLine) ||
    !file.commentableLines.includes(payload.line)
  ) {
    throw new Error('conflict')
  }
  const position = reviewInlinePosition(details, payload.expectedReviewHead)
  if (!position) {
    throw new Error('conflict')
  }
  if (payload.provider === 'github') {
    return assertCompleted(
      await callMobileWebReviewSource(
        'github.addPRReviewComment',
        {
          repo,
          prNumber: payload.reviewNumber,
          commitId: position.headSha,
          path: file.path,
          line: payload.line,
          ...(payload.startLine ? { startLine: payload.startLine } : {}),
          body: payload.body,
          ...gitHubReviewTarget(details)
        },
        context
      )
    )
  }
  if (payload.provider === 'gitlab' && position.baseSha && position.startSha) {
    return assertCompleted(
      await callMobileWebReviewSource(
        'gitlab.addMRInlineComment',
        {
          repo,
          iid: payload.reviewNumber,
          input: {
            body: payload.body,
            path: file.path,
            ...(file.oldPath ? { oldPath: file.oldPath } : {}),
            line: payload.line,
            baseSha: position.baseSha,
            startSha: position.startSha,
            headSha: position.headSha
          },
          ...gitLabReviewTarget(details)
        },
        context
      )
    )
  }
  throw new Error('unsupported_provider')
}

async function replyToThread(
  context: RpcContext,
  repo: string,
  payload: Extract<MobileWebProviderReviewMutationPayload, { action: 'reply' }>,
  details: unknown,
  review: MobileWebProviderReview
): Promise<void> {
  if (payload.provider !== 'github') {
    throw new Error('unsupported_provider')
  }
  const comment = review.comments.find(
    (candidate) =>
      candidate.id === payload.commentId &&
      candidate.threadId === payload.threadId &&
      candidate.allowedActions.includes('reply')
  )
  const commentId = reviewPositiveIntegerString(payload.commentId)
  if (!comment || commentId === null) {
    throw new Error('conflict')
  }
  return assertCompleted(
    await callMobileWebReviewSource(
      'github.addPRReviewCommentReply',
      {
        repo,
        prNumber: payload.reviewNumber,
        commentId,
        threadId: payload.threadId,
        body: payload.body,
        ...(comment.path ? { path: comment.path } : {}),
        ...(comment.line ? { line: comment.line } : {}),
        ...gitHubReviewTarget(details)
      },
      context
    )
  )
}

async function setThreadResolved(
  context: RpcContext,
  repo: string,
  payload: Extract<MobileWebProviderReviewMutationPayload, { action: 'setThreadResolved' }>,
  details: unknown,
  review: MobileWebProviderReview
): Promise<void> {
  const comment = review.comments.find(
    (candidate) =>
      candidate.threadId === payload.threadId && candidate.allowedActions.includes('set-resolved')
  )
  if (!comment) {
    throw new Error('conflict')
  }
  if ((comment.threadState === 'resolved') === payload.resolved) {
    return
  }
  if (payload.provider === 'github') {
    const result = await callMobileWebReviewSource(
      'github.resolveReviewThread',
      {
        repo,
        threadId: payload.threadId,
        resolve: payload.resolved,
        ...gitHubReviewTarget(details)
      },
      context
    )
    if (result !== true) {
      throw new Error('host_error')
    }
    return
  }
  if (payload.provider === 'gitlab') {
    return assertCompleted(
      await callMobileWebReviewSource(
        'gitlab.resolveMRDiscussion',
        {
          repo,
          iid: payload.reviewNumber,
          discussionId: payload.threadId,
          resolved: payload.resolved,
          ...gitLabReviewTarget(details)
        },
        context
      )
    )
  }
  throw new Error('unsupported_provider')
}

function assertCompleted(result: unknown): void {
  if (!isRecord(result) || result.ok !== true) {
    throw new Error('host_error')
  }
}

function mutationResult(
  payload: MobileWebProviderReviewMutationPayload
): MobileWebProviderReviewMutationResult {
  const base = {
    workspaceId: payload.workspaceId,
    provider: payload.provider,
    reviewNumber: payload.reviewNumber,
    outcome: 'completed' as const
  }
  if (payload.action === 'comment') {
    return { ...base, action: payload.action }
  }
  if (payload.action === 'reply') {
    return {
      ...base,
      action: payload.action,
      commentId: payload.commentId,
      threadId: payload.threadId
    }
  }
  if (payload.action === 'inlineComment') {
    return {
      ...base,
      action: payload.action,
      expectedReviewHead: payload.expectedReviewHead,
      path: payload.path,
      line: payload.line,
      ...(payload.startLine ? { startLine: payload.startLine } : {})
    }
  }
  return { ...base, action: payload.action, threadId: payload.threadId, resolved: payload.resolved }
}
