import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { openCodexThread } from './codex-structured-thread-open'
import { verifyCodexForkedHistory } from './codex-structured-fork-history'

const fork = {
  source: { provider: 'codex', threadId: 'parent' },
  throughId: 'kept',
  retainedItemIds: ['codex:parent:kept:0']
} as const

describe('Codex retained fork history', () => {
  it.each(['kept', 'rewritten'])(
    'cross-checks the fork response against turns/list (%s)',
    async (turnId) => {
      const request = vi.fn(async (method: string) => {
        if (method === 'thread/fork') {
          return { thread: { id: 'child', forkedFromId: 'parent', turns: [] } }
        }
        if (method === 'thread/turns/list') {
          return { data: [{ id: turnId }], nextCursor: null }
        }
        return {
          data: [
            {
              turnId,
              item: { id: 'item-1', type: 'userMessage', content: [{ type: 'text', text: 'Kept' }] }
            }
          ],
          nextCursor: null
        }
      })
      const connection = { request } as unknown as CodexAppServerConnection
      const opened = await openCodexThread(
        connection,
        { cwd: '/workspace', resumeThreadId: 'parent' },
        100,
        fork
      )
      const proof = verifyCodexForkedHistory(connection, opened.threadId, fork, 100)
      await (turnId === 'kept'
        ? expect(proof).resolves.toBeUndefined()
        : expect(proof).rejects.toThrow('proof-mismatch'))
      expect(request).toHaveBeenCalledWith(
        'thread/turns/list',
        expect.objectContaining({ threadId: 'child' }),
        { timeoutMs: 100 }
      )
    }
  )
})
