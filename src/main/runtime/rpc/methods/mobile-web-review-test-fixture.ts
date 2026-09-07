import { vi } from 'vitest'
import type { RpcContext } from '../core'
import { GIT_METHODS } from './git'
import { GITHUB_METHODS } from './github'
import { GITLAB_METHODS } from './gitlab'
import { HOSTED_REVIEW_METHODS } from './hosted-review'
import { MOBILE_WEB_REVIEW_METHODS } from './mobile-web-review-methods'
import { WORKTREE_METHODS } from './worktree'

export const REVIEW_WORKTREE = 'id:repo-1::/private/workspace'
export const REVIEW_HEAD = 'b'.repeat(40)
export const REVIEW_BASE = 'a'.repeat(40)
export const REVIEW_BRANCH = 'feature/review'
export const REVIEW_IDENTITY = { expectedHead: REVIEW_HEAD, expectedBranch: REVIEW_BRANCH }

const SOURCES = [
  ...GIT_METHODS,
  ...GITHUB_METHODS,
  ...GITLAB_METHODS,
  ...HOSTED_REVIEW_METHODS,
  ...WORKTREE_METHODS
]

export type ReviewSourceCall = { method: string; params: unknown }
type SourceResponse = unknown

/** Stubs the host methods a review wrapper reaches. Anything it reaches that is not stubbed hits a
 *  runtime this context does not have, which is how an unexpected call shows up as a failure. */
export function stubReviewSources(responses: Record<string, SourceResponse>): ReviewSourceCall[] {
  const calls: ReviewSourceCall[] = []
  for (const [name, response] of Object.entries(responses)) {
    const source = SOURCES.find((method) => method.name === name)
    if (!source) {
      throw new Error(`Unknown review source method: ${name}`)
    }
    vi.spyOn(source, 'handler').mockImplementation(async (params) => {
      calls.push({ method: name, params })
      // A function response lets a test answer the same method differently across calls.
      return typeof response === 'function' ? (response as () => unknown)() : response
    })
  }
  return calls
}

export function runReviewMethod(
  name: string,
  params: Record<string, unknown>,
  context: RpcContext = { signal: new AbortController().signal } as RpcContext
): Promise<unknown> {
  const method = MOBILE_WEB_REVIEW_METHODS.find((entry) => entry.name === name)
  if (!method) {
    throw new Error(`Unknown review method: ${name}`)
  }
  return Promise.resolve(
    method.handler(method.params!.parse({ worktree: REVIEW_WORKTREE, ...params }), context)
  )
}

export function reviewStatus(overrides: Record<string, unknown> = {}) {
  return { head: REVIEW_HEAD, branch: REVIEW_BRANCH, entries: [], ...overrides }
}

export function hostedReviewSummary(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'github',
    number: 42,
    title: 'Add the review lane',
    state: 'open',
    status: 'success',
    updatedAt: '2026-09-07T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    headSha: REVIEW_HEAD,
    ...overrides
  }
}

export function gitHubReviewDetails(overrides: Record<string, unknown> = {}) {
  return {
    item: {
      number: 42,
      type: 'pr',
      author: 'ada',
      prRepo: { owner: 'acme', repo: 'orca', host: 'github.example' },
      reviewRequests: [{ login: 'grace' }],
      latestReviews: []
    },
    body: 'Review body',
    headSha: REVIEW_HEAD,
    baseSha: REVIEW_BASE,
    comments: [],
    files: [],
    checks: [],
    ...overrides
  }
}
