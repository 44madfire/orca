// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  establishStructuredLaunchCancellationAuthority,
  reconcileStructuredLaunchCancellationAuthority,
  requestStructuredLaunchCancellation
} from './structured-agent-session-cancellation-authority'
import { enqueueStructuredAgentSessionLaunchPrompt } from '@/components/native-chat/structured-agent-session-launch-outbox'
import * as storage from '@/components/native-chat/structured-agent-session-outbox-storage'
import {
  transitionOutbox,
  transitionOutboxEntry
} from '@/components/native-chat/structured-agent-session-outbox-transitions'
const { abandon } = vi.hoisted(() => ({ abandon: vi.fn() }))
vi.mock('./launch-structured-agent-session', () => ({
  abandonStructuredAgentSessionLaunchIntent: abandon
}))
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  abandon.mockClear()
})
it.each(['accepted', 'discarded'] as const)(
  'disposes authority after positive %s retirement without retaining later payloads',
  (outcome) => {
    const id = `authority-${outcome}`
    const originalSubscribe = storage.subscribeOutbox
    const disposed = vi.fn()
    vi.spyOn(storage, 'subscribeOutbox').mockImplementation((session, listener) => {
      const detach = originalSubscribe(session, listener)
      return () => {
        disposed()
        detach()
      }
    })
    establishStructuredLaunchCancellationAuthority({
      sessionId: id,
      worktreeId: id,
      agent: 'codex'
    })
    const entry = enqueueStructuredAgentSessionLaunchPrompt(id, 'owned')!
    const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('unavailable')
    })
    reconcileStructuredLaunchCancellationAuthority(id)
    expect(disposed).not.toHaveBeenCalled()
    read.mockRestore()
    transitionOutboxEntry(entry, () => null, outcome === 'accepted')
    expect(disposed).toHaveBeenCalledTimes(1)
    enqueueStructuredAgentSessionLaunchPrompt(id, 'later')
    expect(requestStructuredLaunchCancellation(id, id)).toBeUndefined()
    expect(storage.readOutbox(id)).toHaveLength(1)
    expect(abandon).not.toHaveBeenCalled()
  }
)
it('freezes targets before request and protects later enqueue and Retry while releasing both subscriptions', async () => {
  const id = 'authority-frozen'
  const originalSubscribe = storage.subscribeOutbox
  const disposed = vi.fn()
  vi.spyOn(storage, 'subscribeOutbox').mockImplementation((session, listener) => {
    const detach = originalSubscribe(session, listener)
    return () => {
      disposed()
      detach()
    }
  })
  establishStructuredLaunchCancellationAuthority({ sessionId: id, worktreeId: id, agent: 'codex' })
  const entry = enqueueStructuredAgentSessionLaunchPrompt(id, 'owned')!
  const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
    throw new Error('unavailable')
  })
  expect(requestStructuredLaunchCancellation('wrong-workspace', id)).toBeUndefined()
  expect(requestStructuredLaunchCancellation(id, id)).toBe(false)
  expect(disposed).toHaveBeenCalledTimes(1)
  expect(abandon).not.toHaveBeenCalled()
  read.mockRestore()
  transitionOutboxEntry(entry, (current) => ({ ...current, deliveryIncarnation: 1 }))
  const later = enqueueStructuredAgentSessionLaunchPrompt(id, 'later')!
  await Promise.resolve()
  expect(disposed).toHaveBeenCalledTimes(2)
  expect(storage.readOutbox(id).map((e) => e.clientMessageId)).toEqual([
    entry.clientMessageId,
    later.clientMessageId
  ])
  expect(abandon).toHaveBeenCalledTimes(1)
})
it('retires an unstaged empty authority only after readable evidence', () => {
  const id = 'authority-empty'
  establishStructuredLaunchCancellationAuthority({ sessionId: id, worktreeId: id, agent: 'codex' })
  reconcileStructuredLaunchCancellationAuthority(id)
  transitionOutbox(id, () => [])
  expect(requestStructuredLaunchCancellation(id, id)).toBeUndefined()
})
