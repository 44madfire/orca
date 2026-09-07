import { isReviewRecord, reviewObjectId } from './mobile-web-review-value-bounds'

/** GitHub addresses a fork's pull request by its own repository slug, not the local repo. */
export function gitHubReviewTarget(details: unknown): { prRepo?: Record<string, string> } {
  const item = detailItem(details)
  const prRepo = item && isReviewRecord(item.prRepo) ? item.prRepo : null
  if (!prRepo || !nonemptyString(prRepo.owner) || !nonemptyString(prRepo.repo)) {
    return {}
  }
  return {
    prRepo: {
      owner: prRepo.owner,
      repo: prRepo.repo,
      ...(nonemptyString(prRepo.host) ? { host: prRepo.host } : {})
    }
  }
}

export function gitLabReviewTarget(details: unknown): { projectRef?: Record<string, string> } {
  const item = detailItem(details)
  const projectRef = item && isReviewRecord(item.projectRef) ? item.projectRef : null
  if (!projectRef || !nonemptyString(projectRef.host) || !nonemptyString(projectRef.path)) {
    return {}
  }
  return { projectRef: { host: projectRef.host, path: projectRef.path } }
}

/** GitLab positions an inline comment against all three shas of the merge-request diff. */
export function gitLabReviewPosition(
  details: unknown,
  expectedHead: string
): { baseSha: string; startSha: string; headSha: string } | null {
  if (!isReviewRecord(details)) {
    return null
  }
  const headSha = reviewObjectId(details.headSha)
  const baseSha = reviewObjectId(details.baseSha)
  const startSha = reviewObjectId(details.startSha)
  return headSha === expectedHead && baseSha && startSha ? { baseSha, startSha, headSha } : null
}

/** The provider's inline-comment anchor: GitHub needs only the head, GitLab all three shas. */
export function reviewInlinePosition(
  details: unknown,
  expectedHead: string
): { headSha: string; baseSha?: string; startSha?: string } | null {
  if (!isReviewRecord(details)) {
    return null
  }
  const headSha = reviewObjectId(details.headSha)
  if (headSha !== expectedHead) {
    return null
  }
  const baseSha = reviewObjectId(details.baseSha)
  const startSha = reviewObjectId(details.startSha)
  return { headSha, ...(baseSha ? { baseSha } : {}), ...(startSha ? { startSha } : {}) }
}

function detailItem(details: unknown): Record<string, unknown> | null {
  return isReviewRecord(details) && isReviewRecord(details.item) ? details.item : null
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
