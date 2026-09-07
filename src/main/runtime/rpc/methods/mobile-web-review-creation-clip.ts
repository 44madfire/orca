import { isReviewRecord, reviewPositiveInteger } from './mobile-web-review-value-bounds'

/** The host's eligibility and create answers carry free text a provider wrote; the page contract
 *  caps each field, so they are clipped to it rather than failing the whole call. */
export function clipMobileWebReviewEligibility(value: Record<string, unknown>) {
  return {
    provider: value.provider,
    review: clipReviewSummary(value.review),
    canCreate: value.canCreate === true,
    blockedReason: value.blockedReason ?? null,
    nextAction: value.nextAction ?? null,
    reviewLookupOutcome: value.reviewLookupOutcome,
    ...(value.defaultBaseRef === undefined
      ? {}
      : { defaultBaseRef: clipNullableText(value.defaultBaseRef, 512) }),
    ...(value.head === undefined ? {} : { head: clipNullableText(value.head, 512) }),
    ...(value.title === undefined ? {} : { title: clipNullableText(value.title, 512) }),
    ...(value.body === undefined ? {} : { body: clipNullableText(value.body, 32 * 1024) })
  }
}

export function clipMobileWebReviewCreateResult(value: Record<string, unknown>) {
  if (value.ok === true) {
    return { ok: true, number: value.number, url: value.url }
  }
  return {
    ok: false,
    code: value.code,
    error: reviewBoundedText(value.error, 1024),
    ...(isReviewRecord(value.existingReview)
      ? { existingReview: clipReviewSummary(value.existingReview) }
      : {})
  }
}

export function reviewBoundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function clipReviewSummary(value: unknown) {
  if (!isReviewRecord(value)) {
    return null
  }
  const number = reviewPositiveInteger(value.number)
  return { ...(number ? { number } : {}), url: value.url }
}

function clipNullableText(value: unknown, limit: number): string | null {
  return value === null ? null : reviewBoundedText(value, limit)
}
