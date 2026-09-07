import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcAnyMethod, RpcContext, RpcMethod } from '../core'
import { GIT_METHODS } from './git'
import { REPO_METHODS } from './repo'
import { WORKTREE_METHODS } from './worktree'
import { TERMINAL_SEND_METHODS } from './terminal/terminal-send-method'
import { MOBILE_WEB_SOURCE_CONTROL_REPOSITORY_METHODS } from './mobile-web-source-control-repository'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_METADATA_METHODS } from './mobile-web-source-control-review-metadata'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_LINK_METHODS } from './mobile-web-source-control-review-link'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_DIFF_METHODS } from './mobile-web-source-control-review-diff'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_TERMINAL_METHODS } from './mobile-web-source-control-review-terminal-send'
import { mobileWebReviewMetadataRevision } from '../../../../shared/mobile-web/source-control-review-presentation'

const worktree = 'id:private-host-workspace'
const OID = 'a'.repeat(40)
const METHODS = [
  ...MOBILE_WEB_SOURCE_CONTROL_REPOSITORY_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REVIEW_METADATA_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REVIEW_LINK_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REVIEW_DIFF_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REVIEW_TERMINAL_METHODS
]

function hostMethod(name: string): RpcAnyMethod {
  return [...GIT_METHODS, ...WORKTREE_METHODS, ...REPO_METHODS, ...TERMINAL_SEND_METHODS].find(
    (method) => method.name === name
  )!
}

function stub(name: string, result: unknown) {
  return vi.spyOn(hostMethod(name) as RpcMethod, 'handler').mockResolvedValue(result)
}

async function run(
  name: string,
  params: Record<string, unknown> = {},
  context?: Partial<RpcContext>
) {
  const method = METHODS.find((entry) => entry.name === name)!
  return method.handler(method.params!.parse({ worktree, ...params }), {
    signal: new AbortController().signal,
    ...context
  } as RpcContext)
}

const comment = {
  id: 'comment-1',
  relativePath: 'src/app.ts',
  lineNumber: 4,
  body: 'needs a test',
  createdAt: 1,
  side: 'modified' as const
}

afterEach(() => vi.restoreAllMocks())

describe('host repository state', () => {
  it('composes status, upstream and the workspace base ref into one page-shaped read', async () => {
    stub('git.status', { head: OID, branch: 'main', conflictOperation: 'none' })
    stub('git.upstreamStatus', { hasUpstream: true, ahead: 2, behind: 0, upstreamName: 'origin/x' })
    stub('worktree.show', { worktree: { id: 'wt', repoId: 'repo-1', baseRef: 'origin/main' } })
    await expect(run('mobileWeb.sourceControl.repositoryState')).resolves.toEqual({
      head: OID,
      branch: 'main',
      conflictOperation: 'unknown',
      baseRef: 'origin/main',
      upstream: {
        hasUpstream: true,
        upstreamName: 'origin/x',
        ahead: 2,
        behind: 0,
        hasConfiguredPushTarget: false,
        behindCommitsArePatchEquivalent: false
      }
    })
  })

  it('falls back to the project default when the workspace pinned no base ref', async () => {
    stub('git.status', { head: null, branch: 'main', conflictOperation: 'rebase' })
    stub('git.upstreamStatus', { hasUpstream: false, ahead: 0, behind: 0 })
    stub('worktree.show', { worktree: { id: 'wt', repoId: 'repo-1', path: '/private/repo' } })
    const baseRefDefault = stub('repo.baseRefDefault', { defaultBaseRef: 'origin/trunk' })
    const result = await run('mobileWeb.sourceControl.repositoryState')
    expect(result).toMatchObject({ baseRef: 'origin/trunk', conflictOperation: 'rebase' })
    expect(baseRefDefault.mock.calls[0]![0]).toEqual({ repo: 'id:repo-1' })
    expect(JSON.stringify(result)).not.toContain('private')
  })
})

describe('host review metadata', () => {
  it('projects only review fields off the workspace record', async () => {
    stub('worktree.show', {
      worktree: {
        id: 'wt',
        path: '/private/repo',
        setupScript: 'curl evil',
        diffComments: [{ ...comment, filePath: 'src/app.ts' }],
        mobileDiffReview: { version: 1, files: {} }
      }
    })
    const result = (await run('mobileWeb.sourceControl.reviewMetadata')) as {
      comments: unknown[]
      revision: string
    }
    expect(result.comments).toEqual([comment])
    expect(JSON.stringify(result)).not.toMatch(/private|setupScript|workspaceId/)
  })

  it('refuses a stale write and sends only review fields to the workspace record', async () => {
    const record = {
      id: 'wt',
      path: '/private/repo',
      diffComments: [],
      mobileDiffReview: { version: 1, files: {} }
    }
    stub('worktree.show', { worktree: record })
    const set = stub('worktree.set', { worktree: record })
    const reviewState = { version: 1 as const, files: [] }
    const revision = mobileWebReviewMetadataRevision({
      comments: [],
      reviewState: { version: 1, files: [] }
    })
    await expect(
      run('mobileWeb.sourceControl.reviewMetadataUpdate', {
        expectedRevision: 'b'.repeat(64),
        comments: [],
        reviewState
      })
    ).rejects.toThrow('conflict')
    expect(set).not.toHaveBeenCalled()
    await run('mobileWeb.sourceControl.reviewMetadataUpdate', {
      expectedRevision: revision,
      comments: [comment],
      reviewState
    })
    expect(set.mock.calls[0]![0]).toEqual({
      worktree,
      diffComments: [
        {
          id: 'comment-1',
          worktreeId: 'private-host-workspace',
          filePath: 'src/app.ts',
          lineNumber: 4,
          body: 'needs a test',
          createdAt: 1,
          side: 'modified'
        }
      ],
      mobileDiffReview: { version: 1, files: {} }
    })
  })

  it('rejects a write that names another workspace', async () => {
    stub('worktree.show', { worktree: { id: 'wt' } })
    await expect(
      run('mobileWeb.sourceControl.reviewMetadataUpdate', {
        expectedRevision: 'b'.repeat(64),
        comments: [],
        reviewState: { version: 1, files: [] },
        workspaceId: 'other-workspace'
      })
    ).rejects.toThrow()
  })
})

describe('host review link', () => {
  it('reads the linked review numbers and writes one provider field', async () => {
    const record = { id: 'wt', path: '/private/repo', baseRef: 'main', linkedGitLabMR: 7 }
    stub('worktree.show', { worktree: record })
    const set = stub('worktree.set', { worktree: record })
    await expect(run('mobileWeb.sourceControl.reviewLink')).resolves.toEqual({
      baseRef: 'main',
      linkedGitHubPR: null,
      linkedGitLabMR: 7,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
    await run('mobileWeb.sourceControl.reviewLinkUpdate', { provider: 'github', number: 12 })
    expect(set.mock.calls[0]![0]).toEqual({ worktree, linkedPR: 12 })
  })
})

describe('host review diff', () => {
  it('pages a staged diff and refuses a branch diff without compare identity', async () => {
    stub('git.diff', { kind: 'text', originalContent: 'old\n', modifiedContent: 'new\n' })
    await expect(
      run('mobileWeb.sourceControl.reviewDiff', { relativePath: 'src/app.ts', scope: 'staged' })
    ).resolves.toMatchObject({ kind: 'text', scope: 'staged', relativePath: 'src/app.ts' })
    await expect(
      run('mobileWeb.sourceControl.reviewDiff', { relativePath: 'src/app.ts', scope: 'branch' })
    ).rejects.toThrow()
  })
})

describe('host review terminal send', () => {
  it('resolves the terminal from the requested workspace tab list', async () => {
    const send = stub('terminal.send', { send: { accepted: true } })
    const listMobileSessionTabs = vi.fn().mockResolvedValue({
      worktree: 'private-host-workspace',
      tabs: [{ id: 'tab-1', type: 'terminal', status: 'ready', terminal: 'terminal-1' }]
    })
    await expect(
      run('mobileWeb.sourceControl.reviewTerminalSend', { tabId: 'tab-1', text: 'review this' }, {
        clientId: 'device-1',
        runtime: { listMobileSessionTabs }
      } as unknown as RpcContext)
    ).resolves.toEqual({ accepted: true })
    expect(send.mock.calls[0]![0]).toMatchObject({
      terminal: 'terminal-1',
      text: 'review this',
      enter: true,
      client: { id: 'device-1', type: 'mobile' }
    })
  })

  it('refuses a tab that belongs to another workspace', async () => {
    const send = stub('terminal.send', { send: { accepted: true } })
    const listMobileSessionTabs = vi.fn().mockResolvedValue({
      worktree: 'other-workspace',
      tabs: [{ id: 'tab-1', type: 'terminal', status: 'ready', terminal: 'terminal-1' }]
    })
    await expect(
      run('mobileWeb.sourceControl.reviewTerminalSend', { tabId: 'tab-1', text: 'review this' }, {
        clientId: 'device-1',
        runtime: { listMobileSessionTabs }
      } as unknown as RpcContext)
    ).rejects.toThrow('selector_not_found')
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a tab id the requested workspace does not list', async () => {
    const send = stub('terminal.send', { send: { accepted: true } })
    const listMobileSessionTabs = vi.fn().mockResolvedValue({
      worktree: 'private-host-workspace',
      tabs: [{ id: 'tab-2', type: 'terminal', status: 'ready', terminal: 'terminal-2' }]
    })
    await expect(
      run('mobileWeb.sourceControl.reviewTerminalSend', { tabId: 'tab-1', text: 'review this' }, {
        clientId: 'device-1',
        runtime: { listMobileSessionTabs }
      } as unknown as RpcContext)
    ).rejects.toThrow('selector_not_found')
    expect(send).not.toHaveBeenCalled()
  })
})
