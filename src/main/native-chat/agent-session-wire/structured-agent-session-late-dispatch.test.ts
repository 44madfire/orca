import { describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import {
  settleLateDispatch,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-host-mutations'

describe('late dispatch journal settlement', () => {
  it('waits for the send to persist unknown before accepting and publishing once', async () => {
    const queue = new StructuredAgentSessionTaskQueue()
    let dispatchState = 'pending'
    let releaseSend!: () => void
    const writeBarrier = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    const send = queue.serialize('session', async () => {
      await writeBarrier
      dispatchState = 'unknown'
    })
    const resolveDispatch = vi.fn(async () => {
      dispatchState = 'accepted'
    })
    const publish = vi.fn()
    const context = {
      serialize: queue.serialize.bind(queue),
      sessions: new Map([
        [
          'session',
          {
            fence: 1,
            journal: {
              submissions: () => [{ clientMessageId: 'first', dispatchState }],
              resolveDispatch
            }
          }
        ]
      ]),
      publish
    } as unknown as StructuredAgentSessionMutationContext
    const input = {
      sessionId: 'session',
      clientMessageId: 'first',
      providerIdentity: { provider: 'claude' as const, sessionId: 'provider', uuid: 'first' }
    }
    const settle = settleLateDispatch(context, input)
    expect(resolveDispatch).not.toHaveBeenCalled()
    releaseSend()
    await Promise.all([send, settle])
    expect(dispatchState).toBe('accepted')
    await settleLateDispatch(context, input)
    expect(resolveDispatch).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledOnce()
  })

  it.each(['accepted', 'rejected', 'pending', 'absent'] as const)(
    'does not rewrite a %s submission or publish redundant state',
    async (dispatchState) => {
      const resolveDispatch = vi.fn()
      const publish = vi.fn()
      const context = {
        serialize: async (_sessionId: string, task: () => Promise<void>) => task(),
        sessions: new Map([
          [
            'session',
            {
              fence: 1,
              journal: {
                submissions: () =>
                  dispatchState === 'absent' ? [] : [{ clientMessageId: 'first', dispatchState }],
                resolveDispatch
              }
            }
          ]
        ]),
        publish
      } as unknown as StructuredAgentSessionMutationContext
      await settleLateDispatch(context, {
        sessionId: 'session',
        clientMessageId: 'first',
        providerIdentity: { provider: 'claude', sessionId: 'provider', uuid: 'first' }
      })
      expect(resolveDispatch).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
    }
  )

  it('ignores delivery proof after the host session has closed', async () => {
    const publish = vi.fn()
    const context = {
      serialize: async (_sessionId: string, task: () => Promise<void>) => task(),
      sessions: new Map(),
      publish
    } as unknown as StructuredAgentSessionMutationContext
    await settleLateDispatch(context, {
      sessionId: 'session',
      clientMessageId: 'first',
      providerIdentity: { provider: 'claude', sessionId: 'provider', uuid: 'first' }
    })
    expect(publish).not.toHaveBeenCalled()
  })
})
