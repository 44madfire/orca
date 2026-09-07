import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  gitHubReviewDetails,
  hostedReviewSummary,
  REVIEW_BRANCH,
  REVIEW_HEAD,
  REVIEW_IDENTITY,
  reviewStatus,
  runReviewMethod,
  stubReviewSources
} from './mobile-web-review-test-fixture'

afterEach(() => vi.restoreAllMocks())

describe('host-projected provider review reads', () => {
  it('projects a pull request into the page contract without naming the host worktree', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails({
        comments: [
          { id: 7, author: 'grace', body: 'nit', createdAt: '2026-09-07', threadId: 'thread-1' }
        ],
        files: [
          {
            path: 'src/app.ts',
            status: 'modified',
            additions: 2,
            deletions: 1,
            reviewCommentLineNumbers: [1, 2]
          }
        ]
      })
    })

    const result = await runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY)

    expect(result).toMatchObject({
      observedHead: REVIEW_HEAD,
      branch: REVIEW_BRANCH,
      review: {
        provider: 'github',
        number: 42,
        detailsState: 'loaded',
        author: 'ada',
        allowedSubmissionActions: ['comment', 'approve', 'request-changes'],
        comments: [{ id: '7', kind: 'inline', allowedActions: ['reply', 'set-resolved'] }],
        files: [{ path: 'src/app.ts', commentableLines: [1, 2] }]
      }
    })
    expect(JSON.stringify(result)).not.toMatch(/workspaceId|private/)
    expect(calls.map((call) => call.method)).toEqual([
      'git.status',
      'hostedReview.forBranch',
      'github.workItemDetails'
    ])
  })

  it('refuses a read composed against a head the repository has moved off', async () => {
    stubReviewSources({ 'git.status': reviewStatus({ head: 'c'.repeat(40) }) })

    await expect(runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY)).rejects.toThrow(
      'conflict'
    )
  })

  it('answers a branch with no hosted review without reading provider details', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': null
    })

    await expect(runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY)).resolves.toMatchObject({
      review: null
    })
    expect(calls.map((call) => call.method)).toEqual(['git.status', 'hostedReview.forBranch'])
  })

  it('reports an unreadable work item as unavailable rather than failing the read', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': () => {
        throw new Error('rate_limited')
      }
    })

    await expect(runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY)).resolves.toMatchObject({
      review: { detailsState: 'unavailable', canComment: false, allowedSubmissionActions: [] }
    })
  })

  it('marks a provider with no mobile projection unsupported', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary({ provider: 'bitbucket' })
    })

    await expect(runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY)).resolves.toMatchObject({
      review: { provider: 'bitbucket', detailsState: 'unsupported' }
    })
  })

  it('derives the repo selector from the addressed worktree', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': null
    })

    await runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY)

    expect(calls[1]?.params).toMatchObject({
      repo: 'id:repo-1',
      branch: REVIEW_BRANCH,
      currentHeadOid: REVIEW_HEAD
    })
  })
})

describe('host-projected provider review queries', () => {
  it('clips a check-details answer whose job logs overrun one transport payload', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails({
        checks: [{ name: 'build', status: 'completed', conclusion: 'failure', checkRunId: 9 }]
      }),
      'github.prCheckDetails': {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        jobs: Array.from({ length: 40 }, (_, index) => ({
          name: `job-${index}`,
          status: 'completed',
          conclusion: index === 39 ? 'failure' : 'success',
          logTail: 'x'.repeat(32 * 1024),
          steps: []
        }))
      }
    })

    const result = (await runReviewMethod('mobileWeb.review.query', {
      ...REVIEW_IDENTITY,
      provider: 'github',
      reviewNumber: 42,
      query: 'checkDetails',
      checkName: 'build',
      checkRunId: 9
    })) as { details: { jobs: { name: string }[] } }

    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024)
    expect(result.details.jobs.length).toBeLessThan(40)
    expect(result.details.jobs.at(-1)?.name).toBe('job-39')
  })

  it('refuses check details for a check the review does not carry', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails()
    })

    await expect(
      runReviewMethod('mobileWeb.review.query', {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        query: 'checkDetails',
        checkName: 'build'
      })
    ).rejects.toThrow('conflict')
  })

  it('lists assignable users for the review it was asked about', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails(),
      'github.listAssignableUsers': [{ login: 'ada', name: 'Ada' }, { login: 'grace' }]
    })

    await expect(
      runReviewMethod('mobileWeb.review.query', {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        query: 'assignableUsers'
      })
    ).resolves.toMatchObject({
      query: 'assignableUsers',
      users: [
        { login: 'ada', name: 'Ada' },
        { login: 'grace', name: null }
      ]
    })
    expect(calls.at(-1)?.params).toEqual({ repo: 'id:repo-1' })
  })

  it('refuses a review the branch lookup no longer names', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary({ number: 7 })
    })

    await expect(
      runReviewMethod('mobileWeb.review.query', {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        query: 'assignableUsers'
      })
    ).rejects.toThrow('conflict')
  })
})

describe('host-projected provider review diffs', () => {
  const diffParams = {
    ...REVIEW_IDENTITY,
    provider: 'github' as const,
    reviewNumber: 42,
    expectedReviewHead: REVIEW_HEAD,
    path: 'src/app.ts',
    offset: 0,
    limit: 1
  }
  const file = {
    path: 'src/app.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    reviewCommentLineNumbers: [1]
  }

  it('pages a pull-request file diff the provider answered with whole contents', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails({ files: [file] }),
      'github.prFileContents': { original: 'old\nshared', modified: 'new\nshared' }
    })

    const first = (await runReviewMethod('mobileWeb.review.diff', diffParams)) as {
      revision: string
      rows: unknown[]
      nextOffset: number | null
    }

    expect(first).toMatchObject({ kind: 'text', offset: 0, nextOffset: 1 })
    expect(first.rows).toHaveLength(1)
    await expect(
      runReviewMethod('mobileWeb.review.diff', {
        ...diffParams,
        expectedRevision: '0'.repeat(64)
      })
    ).rejects.toThrow('conflict')
  })

  it('answers a binary review file without reading its contents', async () => {
    const calls = stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails({ files: [{ ...file, isBinary: true }] })
    })

    await expect(runReviewMethod('mobileWeb.review.diff', diffParams)).resolves.toMatchObject({
      kind: 'binary'
    })
    expect(calls.map((call) => call.method)).not.toContain('github.prFileContents')
  })

  it('pages a merge-request patch the provider already shipped inside the work item', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary({ provider: 'gitlab' }),
      'gitlab.workItemDetails': gitHubReviewDetails({
        item: { number: 42, type: 'mr', projectRef: { host: 'gitlab.example', path: 'acme/orca' } },
        files: [{ path: 'src/app.ts', status: 'modified', diff: '@@ -1 +1 @@\n-old\n+new\n' }]
      })
    })

    await expect(
      runReviewMethod('mobileWeb.review.diff', { ...diffParams, provider: 'gitlab', limit: 2 })
    ).resolves.toMatchObject({
      kind: 'text',
      rows: [
        { kind: 'delete', text: 'old' },
        { kind: 'add', text: 'new' }
      ]
    })
  })

  it('refuses a diff for a file the review does not list', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails({ files: [file] })
    })

    await expect(
      runReviewMethod('mobileWeb.review.diff', { ...diffParams, path: 'src/other.ts' })
    ).rejects.toThrow('conflict')
  })

  it('reports a provider file the host refused to read as too large', async () => {
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails({ files: [file] }),
      'github.prFileContents': { modifiedTooLarge: true }
    })

    await expect(runReviewMethod('mobileWeb.review.diff', diffParams)).resolves.toMatchObject({
      kind: 'too-large',
      reason: 'host-limit'
    })
  })

  // Row text is capped at 1024 characters, but each one can escape to six JSON bytes.
  it('clips a diff page whose escaped rows overrun one transport payload', async () => {
    const line = '\u0001'.repeat(1024)
    stubReviewSources({
      'git.status': reviewStatus(),
      'hostedReview.forBranch': hostedReviewSummary(),
      'github.workItemDetails': gitHubReviewDetails({ files: [file] }),
      'github.prFileContents': {
        original: '',
        modified: Array.from({ length: 96 }, () => line).join('\n')
      }
    })

    const result = (await runReviewMethod('mobileWeb.review.diff', {
      ...diffParams,
      limit: 96
    })) as { rows: unknown[]; nextOffset: number | null }

    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512 * 1024)
    expect(result.rows.length).toBeLessThan(96)
    expect(result.nextOffset).toBe(result.rows.length)
  })
})
