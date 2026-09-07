import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { GIT_METHODS } from './git'
import { MOBILE_WEB_SOURCE_CONTROL_COMPARE_METHODS } from './mobile-web-source-control-compare'
import { MOBILE_WEB_SOURCE_CONTROL_HISTORY_METHODS } from './mobile-web-source-control-history'

const context = { signal: new AbortController().signal } as RpcContext
const worktree = 'id:private-host-workspace'
const OID = 'a'.repeat(40)

function fixture(name: string, sourceMethod: string, raw: unknown) {
  const source = GIT_METHODS.find((method) => method.name === sourceMethod)!
  const handler = vi.spyOn(source, 'handler').mockResolvedValue(raw)
  const method = [
    ...MOBILE_WEB_SOURCE_CONTROL_HISTORY_METHODS,
    ...MOBILE_WEB_SOURCE_CONTROL_COMPARE_METHODS
  ].find((entry) => entry.name === name)!
  return {
    handler,
    run: async (params: Record<string, unknown> = {}) =>
      method.handler(method.params!.parse({ worktree, ...params }), context)
  }
}

afterEach(() => vi.restoreAllMocks())

describe('bounded host Source Control history reads', () => {
  it('caps a branch list the page cannot render and reports the true total', async () => {
    const f = fixture('mobileWeb.sourceControl.branches', 'git.localBranches', {
      current: 'main',
      branches: Array.from({ length: 500 }, (_, index) => `branch-${index}`)
    })
    const result = (await f.run()) as { branches: string[]; totalCount: number; truncated: boolean }
    expect(result.branches).toHaveLength(128)
    expect(result).toMatchObject({ totalCount: 500, truncated: true })
    expect(JSON.stringify(result)).not.toContain('workspaceId')
    expect(f.handler).toHaveBeenCalledWith({ worktree }, context)
  })

  it('drops history items that would overrun the bridge budget and marks the page incomplete', async () => {
    const raw = {
      items: Array.from({ length: 100 }, (_, index) => ({
        id: index.toString(16).padStart(40, '0'),
        parentIds: [],
        subject: 'subject',
        message: 'x'.repeat(16 * 1024),
        references: []
      })),
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 100
    }
    const f = fixture('mobileWeb.sourceControl.history', 'git.history', raw)
    const result = (await f.run({ limit: 100 })) as {
      items: { message: string }[]
      hasMore: boolean
    }
    expect(result.items.length).toBeLessThan(100)
    expect(result.hasMore).toBe(true)
    expect(result.items[0]!.message).toHaveLength(8 * 1024)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(192 * 1024)
    expect(f.handler).toHaveBeenCalledWith({ worktree, limit: 100 }, context)
  })

  it('forwards the requested base ref and defaults the history limit', async () => {
    const f = fixture('mobileWeb.sourceControl.history', 'git.history', {
      items: [],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 50
    })
    await f.run({ baseRef: 'origin/main' })
    expect(f.handler).toHaveBeenCalledWith({ worktree, limit: 50, baseRef: 'origin/main' }, context)
    await expect(f.run({ baseRef: '--upload-pack=evil' })).rejects.toThrow()
  })
})

describe('bounded host Source Control compares', () => {
  it('clips a branch compare to the response budget and keeps the reported file count', async () => {
    const raw = {
      summary: {
        baseRef: 'main',
        baseOid: OID,
        compareRef: 'HEAD',
        headOid: 'b'.repeat(40),
        mergeBase: OID,
        changedFiles: 6_000,
        status: 'ready'
      },
      entries: Array.from({ length: 6_000 }, (_, index) => ({
        path: `src/${'deep/'.repeat(8)}file-${index}.ts`,
        status: 'modified'
      }))
    }
    const f = fixture('mobileWeb.sourceControl.branchCompare', 'git.branchCompare', raw)
    const result = (await f.run({ baseRef: 'main' })) as {
      entries: unknown[]
      changedFiles: number
      truncated: boolean
    }
    expect(result.entries.length).toBeLessThan(4_000)
    expect(result).toMatchObject({ changedFiles: 6_000, truncated: true })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(192 * 1024)
    expect(f.handler).toHaveBeenCalledWith({ worktree, baseRef: 'main' }, context)
  })

  it('answers a commit compare in one page and refuses a short commit id', async () => {
    const f = fixture('mobileWeb.sourceControl.commitCompare', 'git.commitCompare', {
      summary: {
        commitOid: OID,
        parentOid: null,
        compareRef: 'HEAD',
        baseRef: 'parent',
        changedFiles: 1,
        status: 'ready'
      },
      entries: [{ path: 'src/app.ts', status: 'modified', added: 2, removed: 1 }]
    })
    await expect(f.run({ commitId: OID })).resolves.toMatchObject({
      commitId: OID,
      entries: [{ relativePath: 'src/app.ts', added: 2, removed: 1 }],
      truncated: false
    })
    await expect(f.run({ commitId: 'abc1234' })).rejects.toThrow()
  })
})
