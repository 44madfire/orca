// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { readOutbox, subscribeOutbox, writeOutbox } from './structured-agent-session-outbox-storage'
import {
  claimOutboxDispatch,
  forgetOutboxDispatch,
  recoverOutboxDispatches
} from './structured-agent-session-outbox-transitions'
const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
const sessionId = 'synthetic-restart'
const target = { kind: 'local' } as const
const submissions = []
function mount() {
  return renderHook(() =>
    useStructuredAgentSessionOutbox({ sessionId, target, fence: 1, submissions })
  )
}
async function advance(ms = 16000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
function entry() {
  return createStructuredAgentSessionOutboxEntry({
    sessionId,
    clientMessageId: 'op',
    text: 'preserve',
    attachments: [{ path: 'synthetic.png', previewUri: 'synthetic-preview' }],
    queuedAt: 1
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1700000100000)
  localStorage.clear()
  mocks.call.mockReset().mockImplementation(() => new Promise(() => {}))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([false, true])(
  'memory-loss schedules spend eight additional probes (already uncertain: %s)',
  async (uncertain) => {
    const original = entry()
    writeOutbox(sessionId, [{ ...original, state: uncertain ? 'unconfirmed' : 'queued' }])
    for (let reload = 0; reload < 12; reload++) {
      const pane = mount()
      await advance()
      const snapshot = readOutbox(sessionId, false)
      // Model realm death: retain the last committed bytes, discard live claims and component state.
      pane.unmount()
      writeOutbox(sessionId, snapshot)
    }
    expect(mocks.call).toHaveBeenCalledTimes(uncertain ? 8 : 9)
    expect(readOutbox(sessionId)[0]).toMatchObject({
      clientMessageId: original.clientMessageId,
      body: original.body,
      previewUris: original.previewUris,
      retryAfterUnknownSubmittedAt: null,
      recovery: { attempts: 8, parkedReason: 'budget-exhausted' }
    })
    const pane = mount()
    act(() => pane.result.current.resumeChecking('op'))
    await advance(1000)
    expect(mocks.call).toHaveBeenCalledTimes(uncertain ? 9 : 10)
    expect(mocks.call.mock.lastCall?.[2].retryUnknown).toBeUndefined()
  }
)

it('a live claim is installed before committed-state observers can recover an orphan', () => {
  writeOutbox(sessionId, [entry()])
  const detach = subscribeOutbox(sessionId, () => {
    recoverOutboxDispatches(sessionId)
  })
  const claim = claimOutboxDispatch(readOutbox(sessionId, false)[0]).entry!
  expect(readOutbox(sessionId, false)[0].state).toBe('dispatching')
  expect(readOutbox(sessionId)[0].recovery).toBeUndefined()
  detach()
  forgetOutboxDispatch(claim)
})

it('a failed orphan-classification write grants no free dispatch and retries safely on remount', async () => {
  writeOutbox(sessionId, [{ ...entry(), state: 'dispatching', lastAttemptAt: Date.now() }])
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  const pane = mount()
  await advance()
  expect(mocks.call).not.toHaveBeenCalled()
  pane.unmount()
  spy.mockRestore()
  mount()
  await advance(1000)
  expect(mocks.call).toHaveBeenCalledTimes(1)
  expect(readOutbox(sessionId)[0].recovery?.attempts).toBe(1)
})

it('failed dispatch persistence releases the unpublished live claim', () => {
  writeOutbox(sessionId, [entry()])
  const original = readOutbox(sessionId, false)[0]
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  expect(claimOutboxDispatch(original).ok).toBe(false)
  spy.mockRestore()
  const claim = claimOutboxDispatch(original).entry!
  forgetOutboxDispatch(claim)
  recoverOutboxDispatches(sessionId)
  expect(readOutbox(sessionId, false)[0].state).toBe('unconfirmed')
})
