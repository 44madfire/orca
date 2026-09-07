import {
  MOBILE_WEB_PROVIDER_REVIEW_CHECK_LIMIT,
  MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT,
  type MobileWebProviderReview
} from '../../../../shared/mobile-web/provider-review-contract'
import {
  isReviewRecord,
  reviewNonemptyString,
  reviewPositiveInteger
} from './mobile-web-review-value-bounds'

export function projectMobileWebReviewUsers(
  value: unknown
): MobileWebProviderReview['reviewRequests'] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .flatMap((entry) => {
      if (!isReviewRecord(entry)) {
        return []
      }
      const login = reviewNonemptyString(entry.login, 80)
      return login ? [{ login, name: reviewNonemptyString(entry.name, 160) ?? null }] : []
    })
    .slice(0, MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT)
}

export function projectMobileWebReviewSummaries(
  value: unknown
): MobileWebProviderReview['latestReviews'] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .flatMap((entry) => {
      if (!isReviewRecord(entry)) {
        return []
      }
      const author = isReviewRecord(entry.author) ? entry.author : null
      const login =
        reviewNonemptyString(entry.login, 80) ??
        (author ? reviewNonemptyString(author.login, 80) : undefined)
      return login ? [{ login, state: reviewNonemptyString(entry.state, 80) ?? null }] : []
    })
    .slice(0, MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT)
}

export function projectMobileWebReviewChecks(value: unknown): MobileWebProviderReview['checks'] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .flatMap((entry) => {
      if (!isReviewRecord(entry)) {
        return []
      }
      const name = reviewNonemptyString(entry.name, 256)
      const status: MobileWebProviderReview['checks'][number]['status'] | null =
        entry.status === 'queued' || entry.status === 'in_progress' || entry.status === 'completed'
          ? entry.status
          : null
      if (!name || !status) {
        return []
      }
      const checkRunId = reviewPositiveInteger(entry.checkRunId)
      const workflowRunId = reviewPositiveInteger(entry.workflowRunId)
      return [
        {
          name,
          status,
          conclusion: checkConclusion(entry.conclusion),
          ...(checkRunId === null ? {} : { checkRunId }),
          ...(workflowRunId === null ? {} : { workflowRunId })
        }
      ]
    })
    .slice(0, MOBILE_WEB_PROVIDER_REVIEW_CHECK_LIMIT)
}

function checkConclusion(value: unknown): MobileWebProviderReview['checks'][number]['conclusion'] {
  return value === 'success' ||
    value === 'failure' ||
    value === 'cancelled' ||
    value === 'timed_out' ||
    value === 'neutral' ||
    value === 'skipped' ||
    value === 'pending' ||
    value === 'action_required'
    ? value
    : null
}
