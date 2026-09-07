import {
  isReviewRecord,
  reviewBoundedString,
  reviewNullableText,
  reviewPositiveInteger
} from './mobile-web-review-value-bounds'

/** A workflow run can carry a hundred jobs of log tail, which no per-field cap bounds in total, so
 *  the oldest jobs drop until the page's answer fits one transport payload. */
const MAX_CHECK_DETAILS_BYTES = 256 * 1024

export function clipMobileWebReviewCheckDetails(value: unknown) {
  if (!isReviewRecord(value) || !reviewBoundedString(value.name, 256)) {
    return null
  }
  const withoutJobs = {
    name: reviewBoundedString(value.name, 256),
    status: reviewNullableText(value.status, 80),
    conclusion: reviewNullableText(value.conclusion, 80),
    startedAt: reviewNullableText(value.startedAt, 64),
    completedAt: reviewNullableText(value.completedAt, 64),
    title: reviewNullableText(value.title, 512),
    summary: reviewNullableText(value.summary, 16 * 1024),
    annotations: clipAnnotations(value.annotations)
  }
  const budget =
    MAX_CHECK_DETAILS_BYTES -
    Buffer.byteLength(JSON.stringify({ ...withoutJobs, jobs: [] as unknown[] }))
  return { ...withoutJobs, jobs: retainedJobs(clipJobs(value.jobs), budget) }
}

/** Newest first: the job a reader opened check details for is the one that just failed. */
function retainedJobs<T>(jobs: T[], budget: number): T[] {
  const retained: T[] = []
  let remaining = budget
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const size = Buffer.byteLength(JSON.stringify(jobs[index])) + 1
    if (retained.length > 0 && size > remaining) {
      break
    }
    remaining -= size
    retained.unshift(jobs[index])
  }
  return retained
}

function clipAnnotations(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .flatMap((entry) =>
      isReviewRecord(entry)
        ? [
            {
              path: reviewNullableText(entry.path, 1024),
              startLine: reviewPositiveInteger(entry.startLine),
              endLine: reviewPositiveInteger(entry.endLine),
              annotationLevel: reviewNullableText(entry.annotationLevel, 80),
              title: reviewNullableText(entry.title, 512),
              message: reviewBoundedString(entry.message, 8 * 1024)
            }
          ]
        : []
    )
    .slice(0, 20)
}

function clipJobs(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .flatMap((entry) =>
      isReviewRecord(entry)
        ? [
            {
              name: reviewBoundedString(entry.name, 256),
              status: reviewNullableText(entry.status, 80),
              conclusion: reviewNullableText(entry.conclusion, 80),
              logTail: reviewNullableText(entry.logTail, 32 * 1024),
              steps: clipSteps(entry.steps)
            }
          ]
        : []
    )
    .slice(0, 100)
}

function clipSteps(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .flatMap((entry) =>
      isReviewRecord(entry)
        ? [
            {
              name: reviewBoundedString(entry.name, 256),
              status: reviewNullableText(entry.status, 80),
              conclusion: reviewNullableText(entry.conclusion, 80)
            }
          ]
        : []
    )
    .slice(0, 100)
}
