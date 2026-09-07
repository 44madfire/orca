import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../shared/agent-session-journal-types'
import {
  armCodexEchoTimeout,
  createCodexDispatchEchoes,
  registerCodexEchoWaiter,
  resolveCodexUserMessageEcho,
  retireCodexEchoWaiter,
  type CodexUserMessageEcho
} from './codex-structured-dispatch-echo'
import { dispatchCodexTurn, type CodexTurnHost } from './codex-structured-turn-start'

const THREAD_ID = 'thread-1'

function codexIdentity(ordinal: number, turnId = 'turn-1'): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: THREAD_ID, turnId, ordinal }
}

function echoFor(
  clientId: string | null,
  identity: AgentJournalItemIdentity = codexIdentity(0),
  threadId = THREAD_ID
): CodexUserMessageEcho {
  return { threadId, clientId, identity }
}

describe('codex dispatch echo registry', () => {
  it('settles the exact clientId match and leaves the other waiter pending', async () => {
    const echoes = createCodexDispatchEchoes()
    const a = registerCodexEchoWaiter(echoes, 'msg-A')
    const b = registerCodexEchoWaiter(echoes, 'msg-B')

    resolveCodexUserMessageEcho(echoes, THREAD_ID, echoFor('msg-B', codexIdentity(2)))

    await expect(b.promise).resolves.toEqual(codexIdentity(2))
    expect(echoes.waiters).toEqual([a.waiter])
    expect(echoes.sawClientIdEcho).toBe(true)
  })

  it('lets a null clientId settle only a sole candidate', async () => {
    const sole = createCodexDispatchEchoes()
    const only = registerCodexEchoWaiter(sole, 'msg-A')
    resolveCodexUserMessageEcho(sole, THREAD_ID, echoFor(null))
    await expect(only.promise).resolves.toEqual(codexIdentity(0))
    expect(sole.sawClientIdEcho).toBe(false)

    const crowded = createCodexDispatchEchoes()
    registerCodexEchoWaiter(crowded, 'msg-A')
    registerCodexEchoWaiter(crowded, 'msg-B')
    resolveCodexUserMessageEcho(crowded, THREAD_ID, echoFor(null))
    expect(crowded.waiters).toHaveLength(2)
  })

  it('retires a waiter on timeout and reports its late echo through the callback', async () => {
    vi.useFakeTimers()
    try {
      const echoes = createCodexDispatchEchoes()
      const { waiter, promise } = registerCodexEchoWaiter(echoes, 'msg-A')
      armCodexEchoTimeout(echoes, waiter, 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(promise).resolves.toBeNull()
      retireCodexEchoWaiter(echoes, waiter)

      const settledLate = vi.fn()
      resolveCodexUserMessageEcho(
        echoes,
        THREAD_ID,
        echoFor('msg-A', codexIdentity(2)),
        settledLate
      )
      expect(settledLate).toHaveBeenCalledWith({
        clientMessageId: 'msg-A',
        providerIdentity: codexIdentity(2)
      })
      expect(echoes.retired).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an echo from another thread and an unstable identity', () => {
    const echoes = createCodexDispatchEchoes()
    registerCodexEchoWaiter(echoes, 'msg-A')

    resolveCodexUserMessageEcho(
      echoes,
      THREAD_ID,
      echoFor('msg-A', codexIdentity(0), 'thread-child')
    )
    resolveCodexUserMessageEcho(echoes, THREAD_ID, {
      threadId: THREAD_ID,
      clientId: 'msg-A',
      identity: { provider: 'orca', clientMessageId: 'codex-item:thread-1:item-9' }
    })

    expect(echoes.waiters).toHaveLength(1)
  })

  it('bounds the retired list', () => {
    const echoes = createCodexDispatchEchoes()
    for (let index = 0; index < 70; index += 1) {
      retireCodexEchoWaiter(echoes, registerCodexEchoWaiter(echoes, `msg-${index}`).waiter)
    }
    expect(echoes.retired).toHaveLength(64)
    expect(echoes.retired[0]?.clientMessageId).toBe('msg-6')
  })
})

const BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ship it' }]
}

function hostFor(request: CodexTurnHost['connection']['request']): CodexTurnHost {
  return {
    threadId: THREAD_ID,
    options: new Map(),
    turnIdWaiters: [],
    activeTurnIds: new Set(),
    dispatchEchoes: createCodexDispatchEchoes(),
    connection: { request }
  }
}

describe('dispatchCodexTurn echo correlation', () => {
  it('accepts an echo that raced the turn/start response', async () => {
    const host = hostFor(async () => {
      resolveCodexUserMessageEcho(host.dispatchEchoes, THREAD_ID, echoFor('msg-A'))
      return { turn: { id: 'turn-1' } }
    })
    await expect(
      dispatchCodexTurn(host, { clientMessageId: 'msg-A', body: BODY }, 50)
    ).resolves.toEqual({ state: 'accepted', providerIdentity: codexIdentity(0) })
  })

  it('falls back to the positional identity for a fresh turn no build echoed', async () => {
    const host = hostFor(async () => ({ turn: { id: 'turn-1' } }))
    await expect(
      dispatchCodexTurn(host, { clientMessageId: 'msg-A', body: BODY }, 5_000, 25)
    ).resolves.toEqual({ state: 'accepted', providerIdentity: codexIdentity(0) })
  })

  it('never falls back for a coalesced send: unknown, then the late echo settles it', async () => {
    const host = hostFor(async () => ({ turn: { id: 'turn-1' } }))
    // The first send proved this build echoes clientIds.
    resolveCodexUserMessageEcho(host.dispatchEchoes, THREAD_ID, echoFor('warm-up'))
    host.activeTurnIds.add('turn-1')

    await expect(
      dispatchCodexTurn(host, { clientMessageId: 'msg-B', body: BODY }, 25)
    ).resolves.toEqual({
      state: 'unknown',
      reason: 'codex accepted a message but did not echo it in time'
    })

    const settledLate = vi.fn()
    resolveCodexUserMessageEcho(
      host.dispatchEchoes,
      THREAD_ID,
      echoFor('msg-B', codexIdentity(2)),
      settledLate
    )
    expect(settledLate).toHaveBeenCalledWith({
      clientMessageId: 'msg-B',
      providerIdentity: codexIdentity(2)
    })
  })

  it('suppresses the fallback when another dispatch is still unsettled', async () => {
    const host = hostFor(async () => ({ turn: { id: 'turn-1' } }))
    registerCodexEchoWaiter(host.dispatchEchoes, 'msg-other')
    await expect(
      dispatchCodexTurn(host, { clientMessageId: 'msg-A', body: BODY }, 5_000, 25)
    ).resolves.toEqual({
      state: 'unknown',
      reason: 'codex accepted a message but did not echo it in time'
    })
  })
})
