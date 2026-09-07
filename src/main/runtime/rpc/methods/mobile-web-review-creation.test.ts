import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REVIEW_BRANCH,
  REVIEW_HEAD,
  REVIEW_IDENTITY,
  reviewStatus,
  runReviewMethod,
  stubReviewSources
} from './mobile-web-review-test-fixture'

afterEach(() => vi.restoreAllMocks())

const eligible = {
  provider: 'github',
  review: null,
  canCreate: true,
  blockedReason: null,
  nextAction: null,
  reviewLookupOutcome: 'not_found'
}

function creationSources(overrides: Record<string, unknown> = {}) {
  return stubReviewSources({
    'git.status': reviewStatus(),
    'git.upstreamStatus': { hasUpstream: true, ahead: 2, behind: 0 },
    'worktree.show': { worktree: { linkedPR: 7, linkedGitLabMR: null } },
    'hostedReview.getCreationEligibility': eligible,
    ...overrides
  })
}

describe('host-projected provider review creation', () => {
  it('reports the working tree, upstream distance and linked reviews to the host', async () => {
    const calls = creationSources({
      'git.status': reviewStatus({ entries: [{ path: 'src/app.ts' }] })
    })

    await expect(
      runReviewMethod('mobileWeb.review.creationEligibility', { ...REVIEW_IDENTITY, base: 'main' })
    ).resolves.toMatchObject({
      observedHead: REVIEW_HEAD,
      branch: REVIEW_BRANCH,
      provider: 'github',
      canCreate: true,
      reviewLookupOutcome: 'not_found'
    })
    expect(calls.at(-1)).toMatchObject({
      method: 'hostedReview.getCreationEligibility',
      params: {
        repo: 'id:repo-1',
        branch: REVIEW_BRANCH,
        base: 'main',
        hasUncommittedChanges: true,
        hasUpstream: true,
        ahead: 2,
        behind: 0,
        linkedGitHubPR: 7,
        linkedGitLabMR: null
      }
    })
  })

  it('refuses eligibility composed against a branch the worktree has left', async () => {
    creationSources({ 'git.status': reviewStatus({ branch: 'main' }) })

    await expect(
      runReviewMethod('mobileWeb.review.creationEligibility', REVIEW_IDENTITY)
    ).rejects.toThrow('conflict')
  })

  it('clips an oversized generated body to the page contract', async () => {
    creationSources({
      'hostedReview.getCreationEligibility': {
        ...eligible,
        title: 't'.repeat(2_000),
        body: 'b'.repeat(64 * 1024)
      }
    })

    const result = (await runReviewMethod(
      'mobileWeb.review.creationEligibility',
      REVIEW_IDENTITY
    )) as { title: string; body: string }

    expect(result.title).toHaveLength(512)
    expect(result.body).toHaveLength(32 * 1024)
  })

  it('creates a review only while the host still says it can be created', async () => {
    const calls = creationSources({ 'hostedReview.create': { ok: true, number: 42, url: 'x' } })

    await expect(
      runReviewMethod('mobileWeb.review.create', {
        ...REVIEW_IDENTITY,
        provider: 'gitlab',
        base: 'main',
        title: 'Add the review lane',
        body: '',
        draft: false
      })
    ).rejects.toThrow('conflict')
    expect(calls.map((call) => call.method)).not.toContain('hostedReview.create')
  })

  it('creates a review and reports the number and url the host answered', async () => {
    const calls = creationSources({
      'hostedReview.create': {
        ok: true,
        number: 42,
        url: 'https://github.example/acme/orca/pull/42'
      }
    })

    await expect(
      runReviewMethod('mobileWeb.review.create', {
        ...REVIEW_IDENTITY,
        provider: 'github',
        base: 'main',
        title: 'Add the review lane',
        body: 'Body',
        draft: true
      })
    ).resolves.toEqual({
      provider: 'github',
      ok: true,
      number: 42,
      url: 'https://github.example/acme/orca/pull/42'
    })
    expect(calls.at(-1)).toMatchObject({
      method: 'hostedReview.create',
      params: { repo: 'id:repo-1', base: 'main', title: 'Add the review lane', draft: true }
    })
  })

  it('reports a refused creation with the host code instead of failing the call', async () => {
    creationSources({
      'hostedReview.create': {
        ok: false,
        code: 'already_exists',
        error: 'e'.repeat(4_000),
        existingReview: { number: 7, url: 'https://github.example/acme/orca/pull/7' }
      }
    })

    const result = (await runReviewMethod('mobileWeb.review.create', {
      ...REVIEW_IDENTITY,
      provider: 'github',
      base: 'main',
      title: 'Add the review lane',
      body: '',
      draft: false
    })) as { error: string; existingReview: { number: number } }

    expect(result.error).toHaveLength(1024)
    expect(result.existingReview).toEqual({
      number: 7,
      url: 'https://github.example/acme/orca/pull/7'
    })
  })

  it('generates review fields for the addressed worktree', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'git.generatePullRequestFields': {
        success: true,
        fields: { base: 'main', title: 'Generated', body: 'Body', draft: false }
      }
    })

    await expect(
      runReviewMethod('mobileWeb.review.generateFields', {
        ...REVIEW_IDENTITY,
        base: 'main',
        title: '',
        body: '',
        draft: false
      })
    ).resolves.toEqual({
      success: true,
      fields: { base: 'main', title: 'Generated', body: 'Body', draft: false }
    })
    expect(calls.at(-1)).toMatchObject({
      method: 'git.generatePullRequestFields',
      params: { worktree: 'id:repo-1::/private/workspace', base: 'main', draft: false }
    })
  })

  it('reports a failed field generation rather than failing the call', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'git.generatePullRequestFields': { success: false, error: 'no model configured' }
    })

    await expect(
      runReviewMethod('mobileWeb.review.generateFields', {
        ...REVIEW_IDENTITY,
        base: 'main',
        title: '',
        body: '',
        draft: false
      })
    ).resolves.toEqual({ success: false, error: 'no model configured' })
  })
})
