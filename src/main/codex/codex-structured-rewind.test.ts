import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import { rewindCodexSession } from './codex-structured-rewind'
import { openCodexThread } from './codex-structured-thread-open'

function fixture() {
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'thread/read') {
      return { thread: { id: 'thread', historyMode: 'paginated', status: { type: 'idle' } } }
    }
    if (method === 'thread/revert') {
      return {
        thread: { id: 'thread', turns: [] },
        turnsBackwardsCursor: 'turn-cursor',
        itemsBackwardsCursor: 'item-cursor'
      }
    }
    if (method === 'thread/turns/list') {
      return { data: [{ id: 'kept' }], nextCursor: null }
    }
    return {
      data: [
        {
          turnId: 'kept',
          item: {
            id: 'item-1',
            type: 'userMessage',
            content: [{ type: 'text', text: 'kept prompt' }]
          }
        }
      ],
      nextCursor: null
    }
  })
  const session = {
    connection: { request },
    threadId: 'thread',
    fence: 2,
    ended: false,
    historyMode: 'paginated',
    activeTurnIds: new Set()
  } as unknown as CodexSession
  return { request, session }
}

describe('Codex rewind', () => {
  it('uses native revert and reads both retained indexes despite empty response turns', async () => {
    const { session, request } = fixture()
    expect(await rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).toMatchObject({
      ok: true,
      items: [{ body: { kind: 'message' } }]
    })
    expect(request).toHaveBeenCalledWith(
      'thread/revert',
      { threadId: 'thread', beforeTurnId: 'drop' },
      { timeoutMs: undefined }
    )
    expect(request).toHaveBeenCalledWith(
      'thread/turns/list',
      expect.objectContaining({ cursor: 'turn-cursor', sortDirection: 'desc' }),
      expect.anything()
    )
    expect(request).toHaveBeenCalledWith(
      'thread/items/list',
      expect.objectContaining({ cursor: 'item-cursor', sortDirection: 'desc' }),
      expect.anything()
    )
  })
  it('refuses a known legacy thread before making a request', async () => {
    const { session, request } = fixture()
    session.historyMode = 'legacy'
    expect(await rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).toEqual({
      ok: false,
      reason: 'history-not-paginated'
    })
    expect(request).not.toHaveBeenCalled()
  })
  it('maps native legacy refusal without exposing provider text or falling back', async () => {
    const { session, request } = fixture()
    request.mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return { thread: { id: 'thread', status: { type: 'idle' } } }
      }
      throw new CodexAppServerRequestError(
        'thread/revert',
        -32600,
        'thread/revert only supports paginated threads'
      )
    })
    expect(await rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).toEqual({
      ok: false,
      reason: 'history-not-paginated'
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual(['thread/read', 'thread/revert'])
  })
  it('refuses activity arriving during the preflight await', async () => {
    const { session, request } = fixture()
    request.mockImplementationOnce(async () => {
      session.activeTurnIds!.add('racing-turn')
      return { thread: { id: 'thread', status: { type: 'idle' } } }
    })
    expect(await rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).toEqual({
      ok: false,
      reason: 'busy'
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('treats hydration failure after revert as unknown and never retries revert', async () => {
    const { session, request } = fixture()
    const original = request.getMockImplementation()!
    request.mockImplementation(async (method) => {
      if (method === 'thread/items/list') {
        throw new Error('offline')
      }
      return original(method)
    })
    await expect(rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).rejects.toThrow(
      'offline'
    )
    expect(request.mock.calls.filter(([method]) => method === 'thread/revert')).toHaveLength(1)
  })
  it('captures history mode at both start and resume without changing defaults', async () => {
    for (const resumeThreadId of [null, 'thread']) {
      const request = vi.fn(async (_method: string, _params?: unknown) => ({
        thread: { id: 'thread', historyMode: 'legacy' }
      }))
      expect(
        await openCodexThread({ request }, { cwd: '/workspace', resumeThreadId }, 10)
      ).toMatchObject({ historyMode: 'legacy' })
      expect(request.mock.calls[0]?.[1]).not.toHaveProperty('historyMode')
    }
  })
})
