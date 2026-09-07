import {
  MOBILE_WEB_PROVIDER_REVIEW_BODY_MAX_CHARACTERS,
  MobileWebProviderReviewSchema,
  type MobileWebProviderReview,
  type MobileWebProviderReviewProvider
} from '../../../../shared/mobile-web/provider-review-contract'
import { projectMobileWebReviewComments } from './mobile-web-review-comment-projection'
import {
  projectMobileWebReviewFiles,
  projectedMobileWebReviewHead
} from './mobile-web-review-file-projection'
import {
  projectMobileWebReviewChecks,
  projectMobileWebReviewSummaries,
  projectMobileWebReviewUsers
} from './mobile-web-review-participant-projection'
import {
  isReviewRecord,
  reviewBoundedString,
  reviewNonemptyString,
  reviewObjectId,
  reviewPositiveInteger
} from './mobile-web-review-value-bounds'

/** Everything the branch lookup knows before the provider work item is read. */
export type MobileWebReviewSummaryProjection = Omit<
  MobileWebProviderReview,
  | 'body'
  | 'comments'
  | 'commentsTruncated'
  | 'files'
  | 'filesTruncated'
  | 'author'
  | 'reviewRequests'
  | 'latestReviews'
  | 'checks'
  | 'detailsState'
  | 'canComment'
  | 'allowedSubmissionActions'
>

export function projectMobileWebReviewSummary(
  value: unknown
): MobileWebReviewSummaryProjection | null {
  if (!isReviewRecord(value)) {
    return null
  }
  const provider = reviewProvider(value.provider)
  const number = reviewPositiveInteger(value.number)
  if (!provider || number === null) {
    return null
  }
  const headSha = reviewObjectId(value.headSha)
  return {
    provider,
    number,
    title: reviewBoundedString(value.title, 512),
    state: reviewState(value.state),
    checksStatus: checksStatus(value.status),
    mergeable: mergeableState(value.mergeable),
    reviewDecision: reviewDecision(value.reviewDecision),
    ...(typeof value.autoMergeEnabled === 'boolean'
      ? { autoMergeEnabled: value.autoMergeEnabled }
      : {}),
    ...(typeof value.autoMergeAllowed === 'boolean' || value.autoMergeAllowed === null
      ? { autoMergeAllowed: value.autoMergeAllowed }
      : {}),
    ...(typeof value.mergeStateStatus === 'string' || value.mergeStateStatus === null
      ? { mergeStateStatus: value.mergeStateStatus }
      : {}),
    updatedAt: reviewBoundedString(value.updatedAt, 64),
    ...(headSha ? { headSha } : {})
  }
}

export function projectMobileWebReviewDetails(
  summary: MobileWebReviewSummaryProjection,
  details: unknown
): MobileWebProviderReview {
  if (summary.provider !== 'github' && summary.provider !== 'gitlab') {
    return emptyReview(summary, 'unsupported')
  }
  if (
    !isReviewRecord(details) ||
    !isReviewRecord(details.item) ||
    reviewPositiveInteger(details.item.number) !== summary.number ||
    details.item.type !== (summary.provider === 'github' ? 'pr' : 'mr')
  ) {
    return emptyReview(summary, 'unavailable')
  }
  const comments = projectMobileWebReviewComments(summary.provider, details.comments)
  const files = projectMobileWebReviewFiles(summary.provider, details.files)
  const headSha = projectedMobileWebReviewHead(details) ?? summary.headSha
  return MobileWebProviderReviewSchema.parse({
    ...summary,
    ...(headSha ? { headSha } : {}),
    body: reviewBoundedString(details.body, MOBILE_WEB_PROVIDER_REVIEW_BODY_MAX_CHARACTERS),
    comments: comments.items,
    commentsTruncated: comments.truncated,
    files: files.items,
    filesTruncated: files.truncated,
    author: reviewNonemptyString(details.item.author, 80) ?? null,
    reviewRequests: projectMobileWebReviewUsers(details.item.reviewRequests),
    latestReviews: projectMobileWebReviewSummaries(details.item.latestReviews),
    checks: projectMobileWebReviewChecks(details.checks),
    detailsState: 'loaded',
    canComment: true,
    allowedSubmissionActions: submissionActions(summary, headSha)
  })
}

function emptyReview(
  summary: MobileWebReviewSummaryProjection,
  detailsState: 'unsupported' | 'unavailable'
): MobileWebProviderReview {
  return MobileWebProviderReviewSchema.parse({
    ...summary,
    body: '',
    comments: [],
    commentsTruncated: false,
    files: [],
    filesTruncated: false,
    author: null,
    reviewRequests: [],
    latestReviews: [],
    checks: [],
    detailsState,
    canComment: false,
    allowedSubmissionActions: []
  })
}

function submissionActions(
  review: MobileWebReviewSummaryProjection,
  headSha: string | undefined
): MobileWebProviderReview['allowedSubmissionActions'] {
  if ((review.state !== 'open' && review.state !== 'draft') || !headSha) {
    return []
  }
  return review.provider === 'github'
    ? ['comment', 'approve', 'request-changes']
    : review.provider === 'gitlab'
      ? ['comment']
      : []
}

function reviewProvider(value: unknown): MobileWebProviderReviewProvider | null {
  return value === 'github' ||
    value === 'gitlab' ||
    value === 'bitbucket' ||
    value === 'azure-devops' ||
    value === 'gitea'
    ? value
    : null
}

function reviewState(value: unknown): MobileWebProviderReview['state'] {
  return value === 'closed' || value === 'merged' || value === 'draft' ? value : 'open'
}

function checksStatus(value: unknown): MobileWebProviderReview['checksStatus'] {
  return value === 'success' || value === 'failure' || value === 'pending' ? value : 'neutral'
}

function mergeableState(value: unknown): MobileWebProviderReview['mergeable'] {
  return value === 'MERGEABLE' || value === 'CONFLICTING' ? value : 'UNKNOWN'
}

function reviewDecision(value: unknown): MobileWebProviderReview['reviewDecision'] {
  return value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED'
    ? value
    : null
}
