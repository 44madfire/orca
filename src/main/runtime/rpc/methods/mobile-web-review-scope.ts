import { z } from 'zod'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { MobileWebProviderReview } from '../../../../shared/mobile-web/provider-review-contract'
import { isStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'
import { GIT_METHODS } from './git'
import { GITHUB_METHODS } from './github'
import { GITLAB_METHODS } from './gitlab'
import { HOSTED_REVIEW_METHODS } from './hosted-review'
import { WORKTREE_METHODS } from './worktree'
import {
  projectMobileWebReviewSummary,
  type MobileWebReviewSummaryProjection
} from './mobile-web-review-projection'

/** The page never learns the host worktree; the shell writes it into `worktree` and the result
 *  carries this placeholder, which the page swaps for its own opaque handle. */
export const MOBILE_WEB_REVIEW_PAGE_IDENTITY = 'page'

export const MobileWebReviewScope = z.object({ worktree: z.string().min(1).max(4096) })

/** The page's payload contract still names a workspace, so the wrapper reads its own params under
 *  the placeholder and hands the page back a result it re-stamps with its opaque handle. */
export function mobileWebReviewPayload<T>(
  schema: z.ZodType<T>,
  params: Record<string, unknown>
): T {
  const { worktree: _worktree, ...rest } = params
  return schema.parse({ ...rest, workspaceId: MOBILE_WEB_REVIEW_PAGE_IDENTITY })
}

export function mobileWebReviewResult<T extends { workspaceId: string }>(
  result: T
): Omit<T, 'workspaceId'> {
  const { workspaceId: _workspaceId, ...rest } = result
  return rest
}

const WORKTREE_SELECTOR_PREFIX = 'id:'

const REVIEW_SOURCE_METHODS = new Map<string, RpcAnyMethod>(
  [
    ...GIT_METHODS,
    ...GITHUB_METHODS,
    ...GITLAB_METHODS,
    ...HOSTED_REVIEW_METHODS,
    ...WORKTREE_METHODS
  ].map((method) => [method.name, method])
)

/** Runs a host method the way the dispatcher would: the source schema still owns its own params,
 *  so a review wrapper cannot smuggle a shape past it. */
export async function callMobileWebReviewSource(
  name: string,
  params: unknown,
  context: RpcContext
): Promise<unknown> {
  const method = REVIEW_SOURCE_METHODS.get(name)
  if (!method || isStreamingMethod(method)) {
    throw new Error(`Missing unary review source method: ${name}`)
  }
  return method.handler(method.params ? method.params.parse(params) : undefined, context)
}

/** The repo half of the worktree id the shell addressed. */
export function mobileWebReviewRepoSelector(worktree: string): string {
  if (!worktree.startsWith(WORKTREE_SELECTOR_PREFIX)) {
    throw new Error('selector_not_found')
  }
  const worktreeId = worktree.slice(WORKTREE_SELECTOR_PREFIX.length)
  return `${WORKTREE_SELECTOR_PREFIX}${getRepoIdFromWorktreeId(worktreeId)}`
}

export type MobileWebReviewIdentity = {
  worktree: string
  expectedHead: string
  expectedBranch: string
}

/** The page's optimistic concurrency check: every review call names the head and branch it was
 *  composed against, and a repository that has moved since fails instead of acting on stale rows. */
export async function assertMobileWebReviewIdentity(
  context: RpcContext,
  identity: MobileWebReviewIdentity
): Promise<void> {
  const status = await callMobileWebReviewSource(
    'git.status',
    { worktree: identity.worktree },
    context
  )
  if (!isRecord(status)) {
    throw new Error('host_error')
  }
  if (status.head !== identity.expectedHead || status.branch !== identity.expectedBranch) {
    throw new Error('conflict')
  }
}

export async function readMobileWebReviewSummary(
  context: RpcContext,
  repo: string,
  identity: MobileWebReviewIdentity
): Promise<MobileWebReviewSummaryProjection | null> {
  const result = await callMobileWebReviewSource(
    'hostedReview.forBranch',
    { repo, branch: identity.expectedBranch, currentHeadOid: identity.expectedHead },
    context
  )
  if (result === null) {
    return null
  }
  const summary = projectMobileWebReviewSummary(result)
  if (!summary) {
    throw new Error('host_error')
  }
  return summary
}

/** The summary alone carries no body, comments or files; those live behind a provider-specific
 *  work-item read that answers null for a provider with no mobile projection. */
export async function readMobileWebReviewDetails(
  context: RpcContext,
  repo: string,
  review: Pick<MobileWebProviderReview, 'provider' | 'number'>
): Promise<unknown> {
  if (review.provider === 'github') {
    return callMobileWebReviewSource(
      'github.workItemDetails',
      { repo, number: review.number, type: 'pr' },
      context
    ).catch(() => null)
  }
  if (review.provider === 'gitlab') {
    return callMobileWebReviewSource(
      'gitlab.workItemDetails',
      { repo, iid: review.number, type: 'mr' },
      context
    ).catch(() => null)
  }
  return null
}

/** Reads the summary and its details for a call that names one review, refusing a repository whose
 *  current review is not the one the page addressed. */
export async function readMobileWebReviewTarget(
  context: RpcContext,
  identity: MobileWebReviewIdentity & {
    provider: MobileWebProviderReview['provider']
    reviewNumber: number
  }
): Promise<{ repo: string; summary: MobileWebReviewSummaryProjection; details: unknown }> {
  await assertMobileWebReviewIdentity(context, identity)
  const repo = mobileWebReviewRepoSelector(identity.worktree)
  const summary = await readMobileWebReviewSummary(context, repo, identity)
  if (
    !summary ||
    summary.provider !== identity.provider ||
    summary.number !== identity.reviewNumber
  ) {
    throw new Error('conflict')
  }
  return { repo, summary, details: await readMobileWebReviewDetails(context, repo, summary) }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
