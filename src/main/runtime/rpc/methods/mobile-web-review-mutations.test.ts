import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  gitHubReviewDetails,
  hostedReviewSummary,
  REVIEW_HEAD,
  REVIEW_IDENTITY,
  reviewStatus,
  runReviewMethod,
  stubReviewSources
} from './mobile-web-review-test-fixture'

afterEach(() => vi.restoreAllMocks())

const commentFile = {
  path: 'src/app.ts',
  status: 'modified',
  additions: 1,
  deletions: 0,
  reviewCommentLineNumbers: [4, 5]
}

describe('host-projected provider review comment mutations', () => {
  it('addresses a conversation comment to the pull request own repository slug', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails(),
      'github.addIssueComment': { ok: true }
    })

    await expect(
      runReviewMethod('mobileWeb.review.comment', {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        action: 'comment',
        body: 'Looks good.'
      })
    ).resolves.toEqual({
      provider: 'github',
      reviewNumber: 42,
      action: 'comment',
      outcome: 'completed'
    })
    expect(calls.at(-1)).toMatchObject({
      method: 'github.addIssueComment',
      params: {
        repo: 'id:repo-1',
        number: 42,
        body: 'Looks good.',
        prRepo: { owner: 'acme', repo: 'orca', host: 'github.example' }
      }
    })
  })

  it('posts a merge-request comment through the GitLab project reference', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary({ provider: 'gitlab' }),
      'gitlab.workItemDetails': gitHubReviewDetails({
        item: { number: 42, type: 'mr', projectRef: { host: 'gitlab.example', path: 'acme/orca' } }
      }),
      'gitlab.addMRComment': { ok: true }
    })

    await runReviewMethod('mobileWeb.review.comment', {
      ...REVIEW_IDENTITY,
      provider: 'gitlab',
      reviewNumber: 42,
      action: 'comment',
      body: 'Looks good.'
    })

    expect(calls.at(-1)).toMatchObject({
      method: 'gitlab.addMRComment',
      params: { iid: 42, projectRef: { host: 'gitlab.example', path: 'acme/orca' } }
    })
  })

  it('refuses an inline comment on a line the review diff does not expose', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails({ files: [commentFile] })
    })

    await expect(
      runReviewMethod('mobileWeb.review.comment', {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        action: 'inlineComment',
        expectedReviewHead: REVIEW_HEAD,
        path: 'src/app.ts',
        line: 9,
        body: 'nit'
      })
    ).rejects.toThrow('conflict')
  })

  it('anchors an inline comment to the head the page composed it against', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails({ files: [commentFile] }),
      'github.addPRReviewComment': { ok: true }
    })

    await runReviewMethod('mobileWeb.review.comment', {
      ...REVIEW_IDENTITY,
      provider: 'github',
      reviewNumber: 42,
      action: 'inlineComment',
      expectedReviewHead: REVIEW_HEAD,
      path: 'src/app.ts',
      line: 5,
      startLine: 4,
      body: 'nit'
    })

    expect(calls.at(-1)).toMatchObject({
      method: 'github.addPRReviewComment',
      params: { commitId: REVIEW_HEAD, path: 'src/app.ts', line: 5, startLine: 4 }
    })
  })

  it('does not write when the branch moves between reading the review and posting', async () => {
    let statusReads = 0
    const calls = stubReviewSources({
      'git.status': () => {
        statusReads += 1
        return statusReads === 1 ? reviewStatus() : reviewStatus({ branch: 'main' })
      },
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails(),
      'github.addIssueComment': { ok: true }
    })

    await expect(
      runReviewMethod('mobileWeb.review.comment', {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        action: 'comment',
        body: 'Looks good.'
      })
    ).rejects.toThrow('conflict')
    expect(calls.map((call) => call.method)).not.toContain('github.addIssueComment')
  })

  it('treats resolving an already resolved thread as done without calling the provider', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails({
        comments: [
          {
            id: 7,
            author: 'grace',
            body: 'nit',
            createdAt: '2026-09-07',
            threadId: 'thread-1',
            isResolved: true
          }
        ]
      })
    })

    await expect(
      runReviewMethod('mobileWeb.review.comment', {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        action: 'setThreadResolved',
        threadId: 'thread-1',
        resolved: true
      })
    ).resolves.toMatchObject({ action: 'setThreadResolved', resolved: true })
    expect(calls.map((call) => call.method)).not.toContain('github.resolveReviewThread')
  })
})

describe('host-projected provider review management', () => {
  it('refuses reviewers the repository will not accept', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails(),
      'github.listAssignableUsers': [{ login: 'ada' }],
      'github.requestPRReviewers': { ok: true }
    })

    await expect(
      runReviewMethod('mobileWeb.review.manage', {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        action: 'requestReviewers',
        reviewers: ['mallory']
      })
    ).rejects.toThrow('conflict')
    expect(calls.map((call) => call.method)).not.toContain('github.requestPRReviewers')
  })

  it('merges with the requested method and echoes the action back', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails(),
      'github.mergePR': { ok: true }
    })

    await expect(
      runReviewMethod('mobileWeb.review.manage', {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        action: 'merge',
        method: 'squash'
      })
    ).resolves.toEqual({
      provider: 'github',
      reviewNumber: 42,
      action: 'merge',
      outcome: 'completed'
    })
    expect(calls.at(-1)).toMatchObject({
      method: 'github.mergePR',
      params: { prNumber: 42, method: 'squash', prRepo: { owner: 'acme', repo: 'orca' } }
    })
  })

  it('refuses a rerun composed against a head the review has moved off', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails()
    })

    await expect(
      runReviewMethod('mobileWeb.review.manage', {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        action: 'rerunChecks',
        expectedReviewHead: 'd'.repeat(40)
      })
    ).rejects.toThrow('conflict')
  })

  it('refuses management on a provider with no mobile projection', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary({ provider: 'gitlab' }),
      'gitlab.workItemDetails': gitHubReviewDetails({
        item: { number: 42, type: 'mr', projectRef: { host: 'gitlab.example', path: 'acme/orca' } }
      })
    })

    await expect(
      runReviewMethod('mobileWeb.review.manage', {
        ...REVIEW_IDENTITY,
        provider: 'gitlab',
        reviewNumber: 42,
        action: 'merge'
      })
    ).rejects.toThrow('unsupported_provider')
  })
})

describe('host-projected provider review submission', () => {
  const submission = {
    ...REVIEW_IDENTITY,
    provider: 'github' as const,
    reviewNumber: 42,
    expectedReviewHead: REVIEW_HEAD,
    submissionId: 'submission_1234567890',
    action: 'approve' as const,
    summary: 'Ship it.',
    comments: []
  }

  it('submits a queued review against the pull request own repository slug', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails({ files: [commentFile] }),
      'hostedReview.submit': { ok: true, action: 'approve', submittedComments: 1 }
    })

    await expect(
      runReviewMethod('mobileWeb.review.submit', {
        ...submission,
        comments: [
          {
            id: 'comment_0000000000',
            path: 'src/app.ts',
            line: 5,
            startLine: 4,
            body: 'nit'
          }
        ]
      })
    ).resolves.toMatchObject({
      action: 'approve',
      submittedCommentIds: ['comment_0000000000'],
      outcome: 'completed'
    })
    expect(calls.at(-1)).toMatchObject({
      method: 'hostedReview.submit',
      params: {
        provider: 'github',
        number: 42,
        expectedHead: REVIEW_HEAD,
        repository: { owner: 'acme', repo: 'orca' },
        comments: [{ path: 'src/app.ts', line: 5, startLine: 4 }]
      }
    })
  })

  it('refuses a verdict the review does not allow', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary({ state: 'merged' }),
      'github.workItemDetails': gitHubReviewDetails()
    })

    await expect(runReviewMethod('mobileWeb.review.submit', submission)).rejects.toThrow('conflict')
  })

  it('refuses a submission the host acknowledged for a different comment count', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails(),
      'hostedReview.submit': { ok: true, action: 'approve', submittedComments: 3 }
    })

    await expect(runReviewMethod('mobileWeb.review.submit', submission)).rejects.toThrow(
      'host_error'
    )
  })
})
