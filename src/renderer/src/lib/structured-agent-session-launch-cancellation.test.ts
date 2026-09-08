// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hasStructuredLaunchCancellation,
  persistStructuredLaunchCancellation,
  retryStructuredLaunchCancellation,
  subscribeStructuredLaunchCancellation
} from './structured-agent-session-launch-cancellation'
import { enqueueStructuredAgentSessionLaunchPrompt } from '@/components/native-chat/structured-agent-session-launch-outbox'
import * as storage from '@/components/native-chat/structured-agent-session-outbox-storage'
import {
  readOutbox,
  subscribeOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import {
  transitionOutbox,
  transitionOutboxEntry
} from '@/components/native-chat/structured-agent-session-outbox-transitions'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'

const { abandon } = vi.hoisted(() => ({ abandon: vi.fn() }))
vi.mock('./launch-structured-agent-session', () => ({
  abandonStructuredAgentSessionLaunchIntent: abandon
}))
function intent(id: string): StructuredAgentSessionLaunchIntent {
  return {
    sessionId: id,
    worktreeId: id,
    agent: 'codex',
    params: {} as StructuredAgentSessionLaunchIntent['params']
  }
}
function failRemoval() {
  return vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
    throw new Error('synthetic storage failure')
  })
}
afterEach(() => {
  vi.restoreAllMocks()
  abandon.mockClear()
  localStorage.clear()
})

describe('cancellation persistence ownership', () => {
  it('retains one obligation through repeated failures and disposes its storage/status subscriptions on success', async () => {
    const originalSubscribe = storage.subscribeOutbox
    const storageDetach = vi.fn()
    vi.spyOn(storage, 'subscribeOutbox').mockImplementation((session, listener) => {
      const detach = originalSubscribe(session, listener)
      return () => {
        storageDetach()
        detach()
      }
    })
    const launch = intent('cancel-repeated')
    enqueueStructuredAgentSessionLaunchPrompt(launch.sessionId, 'old')
    const notify = vi.fn()
    const detach = subscribeStructuredLaunchCancellation(notify)
    const failure = failRemoval()
    expect(persistStructuredLaunchCancellation(launch)).toBe(false)
    for (let i = 0; i < 4; i++) {
      expect(retryStructuredLaunchCancellation(launch.worktreeId, launch.sessionId)).toBe(false)
    }
    expect(failure).toHaveBeenCalledTimes(5)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(abandon).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(failure).toHaveBeenCalledTimes(5)
    failure.mockRestore()
    expect(retryStructuredLaunchCancellation(launch.worktreeId, launch.sessionId)).toBe(true)
    expect(hasStructuredLaunchCancellation(launch.worktreeId, 'codex')).toBe(false)
    expect(retryStructuredLaunchCancellation(launch.worktreeId, launch.sessionId)).toBeUndefined()
    detach()
    enqueueStructuredAgentSessionLaunchPrompt(launch.sessionId, 'later')
    await Promise.resolve()
    expect(readOutbox(launch.sessionId)).toHaveLength(1)
    expect(abandon).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(storageDetach).toHaveBeenCalledTimes(1)
  })

  it('retries after a storage recovery commit without removing an unrelated later operation', async () => {
    const launch = intent('cancel-recovery')
    enqueueStructuredAgentSessionLaunchPrompt(launch.sessionId, 'old')
    const failure = failRemoval()
    expect(persistStructuredLaunchCancellation(launch)).toBe(false)
    failure.mockRestore()
    const later = enqueueStructuredAgentSessionLaunchPrompt(launch.sessionId, 'later')!
    await Promise.resolve()
    expect(readOutbox(launch.sessionId).map((e) => e.clientMessageId)).toEqual([
      later.clientMessageId
    ])
    expect(hasStructuredLaunchCancellation(launch.worktreeId, 'codex')).toBe(false)
    expect(abandon).toHaveBeenCalledTimes(1)
  })

  it('does not remove an explicit Retry incarnation or let stale completion remove it', async () => {
    const launch = intent('cancel-incarnation')
    const old = enqueueStructuredAgentSessionLaunchPrompt(launch.sessionId, 'old')!
    const failure = failRemoval()
    expect(persistStructuredLaunchCancellation(launch)).toBe(false)
    failure.mockRestore()
    transitionOutboxEntry(old, (current) => ({ ...current, deliveryIncarnation: 1 }))
    await Promise.resolve()
    expect(readOutbox(launch.sessionId)[0].deliveryIncarnation).toBe(1)
    expect(transitionOutboxEntry(old, () => null, true).changed).toBe(false)
    expect(hasStructuredLaunchCancellation(launch.worktreeId, 'codex')).toBe(false)
    expect(readOutbox(launch.sessionId)).toHaveLength(1)
  })

  it('defers commit retries and rejects synchronous reentrant retry', async () => {
    const launch = intent('cancel-reentrant')
    enqueueStructuredAgentSessionLaunchPrompt(launch.sessionId, 'old')
    const failure = failRemoval()
    expect(persistStructuredLaunchCancellation(launch)).toBe(false)
    failure.mockRestore()
    const nested: (boolean | undefined)[] = []
    const detach = subscribeOutbox(launch.sessionId, () =>
      nested.push(retryStructuredLaunchCancellation(launch.worktreeId, launch.sessionId))
    )
    expect(retryStructuredLaunchCancellation(launch.worktreeId, launch.sessionId)).toBe(true)
    expect(nested).toEqual([false])
    detach()
    enqueueStructuredAgentSessionLaunchPrompt(launch.sessionId, 'new generation')
    await Promise.resolve()
    expect(readOutbox(launch.sessionId)).toHaveLength(1)
    expect(abandon).toHaveBeenCalledTimes(1)
  })

  it('bounds a failed commit-triggered retry without a self-scheduling loop', async () => {
    const launch = intent('cancel-failed-retry')
    const old = enqueueStructuredAgentSessionLaunchPrompt(launch.sessionId, 'old')!
    const failure = failRemoval()
    expect(persistStructuredLaunchCancellation(launch)).toBe(false)
    transitionOutboxEntry(old, (current) => ({ ...current, state: 'unconfirmed' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(failure).toHaveBeenCalledTimes(2)
    expect(hasStructuredLaunchCancellation(launch.worktreeId, 'codex')).toBe(true)
    failure.mockRestore()
    expect(retryStructuredLaunchCancellation(launch.worktreeId, launch.sessionId)).toBe(true)
  })

  it('ignores the wrong worktree and disposes when another owner durably removes the targeted incarnation', async () => {
    const launch = intent('cancel-external-retirement')
    enqueueStructuredAgentSessionLaunchPrompt(launch.sessionId, 'old')
    const failure = failRemoval()
    expect(persistStructuredLaunchCancellation(launch)).toBe(false)
    expect(retryStructuredLaunchCancellation('other', launch.sessionId)).toBeUndefined()
    failure.mockRestore()
    transitionOutbox(launch.sessionId, () => [])
    await Promise.resolve()
    expect(hasStructuredLaunchCancellation(launch.worktreeId, 'codex')).toBe(false)
    expect(abandon).toHaveBeenCalledTimes(1)
  })
  it('does not run a queued retry against a newer cancellation generation for the same session', async () => {
    const launch = intent('cancel-record-generation')
    enqueueStructuredAgentSessionLaunchPrompt(launch.sessionId, 'first')
    expect(persistStructuredLaunchCancellation(launch)).toBe(true)
    enqueueStructuredAgentSessionLaunchPrompt(launch.sessionId, 'second')
    const failure = failRemoval()
    expect(persistStructuredLaunchCancellation(launch)).toBe(false)
    await Promise.resolve()
    expect(failure).toHaveBeenCalledTimes(1)
    expect(readOutbox(launch.sessionId)).toHaveLength(1)
    failure.mockRestore()
    expect(retryStructuredLaunchCancellation(launch.worktreeId, launch.sessionId)).toBe(true)
  })
})
