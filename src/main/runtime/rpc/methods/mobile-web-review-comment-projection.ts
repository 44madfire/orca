import {
  MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT,
  MOBILE_WEB_PROVIDER_REVIEW_COMMENT_MAX_CHARACTERS,
  MobileWebProviderReviewCommentSchema,
  type MobileWebProviderReviewComment,
  type MobileWebProviderReviewProvider
} from '../../../../shared/mobile-web/provider-review-contract'
import {
  isReviewRecord,
  reviewBoundedString,
  reviewNonemptyString,
  reviewPositiveInteger,
  reviewPositiveIntegerString,
  reviewRelativePath
} from './mobile-web-review-value-bounds'

export function projectMobileWebReviewComments(
  provider: MobileWebProviderReviewProvider,
  value: unknown
): { items: MobileWebProviderReviewComment[]; truncated: boolean } {
  if (!Array.isArray(value)) {
    return { items: [], truncated: false }
  }
  const parsed = value.flatMap((entry): MobileWebProviderReviewComment[] => {
    const comment = projectReviewComment(provider, entry)
    return comment ? [comment] : []
  })
  return {
    items: parsed.slice(-MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT),
    truncated: parsed.length > MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT
  }
}

function projectReviewComment(
  provider: MobileWebProviderReviewProvider,
  value: unknown
): MobileWebProviderReviewComment | null {
  if (!isReviewRecord(value)) {
    return null
  }
  const id = commentIdentifier(value.id)
  if (!id) {
    return null
  }
  const path = reviewRelativePath(value.path)
  const line = reviewPositiveInteger(value.line)
  const startLine = reviewPositiveInteger(value.startLine)
  const threadId = reviewNonemptyString(value.threadId, 256)
  const parsed = MobileWebProviderReviewCommentSchema.safeParse({
    id,
    author: reviewBoundedString(value.author, 160),
    body: reviewBoundedString(value.body, MOBILE_WEB_PROVIDER_REVIEW_COMMENT_MAX_CHARACTERS),
    createdAt: reviewBoundedString(value.createdAt, 64),
    kind: path || line !== null || threadId ? 'inline' : 'conversation',
    ...(path ? { path } : {}),
    ...(line !== null ? { line } : {}),
    ...(startLine !== null ? { startLine } : {}),
    ...(threadId ? { threadId, threadState: commentThreadState(value) } : {}),
    allowedActions: commentActions(provider, id, threadId),
    ...(typeof value.isBot === 'boolean' ? { isBot: value.isBot } : {})
  })
  return parsed.success ? parsed.data : null
}

/** Only a threaded comment can be replied to or resolved, and only GitHub addresses a reply by the
 *  numeric comment id. */
function commentActions(
  provider: MobileWebProviderReviewProvider,
  commentId: string,
  threadId: string | undefined
): MobileWebProviderReviewComment['allowedActions'] {
  if (!threadId) {
    return []
  }
  const actions: MobileWebProviderReviewComment['allowedActions'] = []
  if (provider === 'github' && reviewPositiveIntegerString(commentId) !== null) {
    actions.push('reply')
  }
  if (provider === 'github' || provider === 'gitlab') {
    actions.push('set-resolved')
  }
  return actions
}

function commentThreadState(
  value: Record<string, unknown>
): NonNullable<MobileWebProviderReviewComment['threadState']> {
  if (value.isOutdated === true) {
    return 'outdated'
  }
  return value.isResolved === true ? 'resolved' : 'open'
}

function commentIdentifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value)
  }
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : null
}
