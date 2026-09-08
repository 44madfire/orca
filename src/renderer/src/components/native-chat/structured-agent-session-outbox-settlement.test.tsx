// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  discardStructuredAgentSessionLaunchOutbox
} from './structured-agent-session-launch-outbox'
import { observeOutboxSettlement } from './structured-agent-session-outbox-settlement'
import { readOutbox } from './structured-agent-session-outbox-storage'
import {
  hasOutboxDispatch,
  transitionOutboxEntry
} from './structured-agent-session-outbox-transitions'
import { settleStructuredAgentLaunchPrompt } from '@/lib/structured-agent-session-launch-prompt'
const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
const sessionId = 'synthetic-settlement'
const target = { kind: 'local' } as const
const submissions = []
function mount() {
  return renderHook(() =>
    useStructuredAgentSessionOutbox({ sessionId, target, fence: 1, submissions })
  )
}
function accepted() {
  return { ok: true, value: { submission: { dispatchState: 'accepted' } } }
}
function launch(
  stagedEntry: NonNullable<ReturnType<typeof enqueueStructuredAgentSessionLaunchPrompt>>,
  onPromptDelivered = vi.fn()
) {
  return settleStructuredAgentLaunchPrompt({
    stagedEntry,
    options: { prompt: 'launch', onPromptDelivered },
    launchResult: Promise.resolve({ sessionId, fence: 1 })
  })!
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1700000100000)
  localStorage.clear()
  mocks.call.mockReset().mockResolvedValue(accepted())
})
afterEach(() => {
  cleanup()
  discardStructuredAgentSessionLaunchOutbox(sessionId)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('every joined caller observes pane acceptance once, including callers arriving after settlement', async () => {
  const staged = enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'launch')!
  const finish = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValueOnce(finish.promise)
  mount()
  const callbacks = [vi.fn(), vi.fn(), vi.fn()]
  const first = launch(staged, callbacks[0])
  const second = launch(staged, callbacks[1])
  await act(async () => {
    finish.resolve(accepted())
  })
  const third = launch(staged, callbacks[2])
  for (const delivery of [first, second, third]) {
    expect(await delivery).toMatchObject({ delivered: true })
  }
  for (const callback of callbacks) {
    expect(callback).toHaveBeenCalledTimes(1)
  }
  expect(mocks.call).toHaveBeenCalledTimes(1)
})

it('a launch winner observes journal settlement while its own RPC remains pending', async () => {
  const staged = enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'launch')!
  mocks.call.mockReturnValueOnce(new Promise(() => {}))
  const delivery = launch(staged)
  await act(async () => {})
  const claim = readOutbox(sessionId, false)[0]
  transitionOutboxEntry(claim, () => null, true)
  expect(hasOutboxDispatch(claim)).toBe(false)
  expect(await delivery).toMatchObject({ delivered: true })
  expect(mocks.call).toHaveBeenCalledTimes(1)
})

it('launch-owned FIFO waits for the preceding operation and sends each body once', async () => {
  const first = enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'first')!
  const second = enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'second')!
  const finish = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValueOnce(finish.promise)
  const firstDelivery = launch(first)
  const secondDelivery = launch(second)
  await act(async () => {})
  expect(mocks.call).toHaveBeenCalledTimes(1)
  await act(async () => {
    finish.resolve(accepted())
  })
  expect(await firstDelivery).toMatchObject({ delivered: true })
  expect(await secondDelivery).toMatchObject({ delivered: true })
  expect(mocks.call).toHaveBeenCalledTimes(2)
  expect(mocks.call.mock.calls.map((call) => call[2].body.blocks[0].text)).toEqual([
    'first',
    'second'
  ])
})

it('discard and memory loss are never reported as acceptance, even after a stale RPC succeeds', async () => {
  const staged = enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'launch')!
  const finish = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValueOnce(finish.promise)
  const callback = vi.fn()
  const delivery = launch(staged, callback)
  await act(async () => {})
  discardStructuredAgentSessionLaunchOutbox(sessionId)
  expect(await delivery).toMatchObject({ delivered: false })
  await act(async () => {
    finish.resolve(accepted())
  })
  expect(callback).not.toHaveBeenCalled()
  expect(await observeOutboxSettlement({ ...staged })).toBe('unavailable')
  expect(await launch(staged)).toMatchObject({ delivered: false })
})

it('Retry ends the old incarnation observation and ignores its stale acceptance', async () => {
  const staged = enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'launch')!
  const finish = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValueOnce(finish.promise).mockReturnValueOnce(new Promise(() => {}))
  const pane = mount()
  const callback = vi.fn()
  const delivery = launch(staged, callback)
  act(() => pane.result.current.retry(staged.clientMessageId))
  expect(await delivery).toMatchObject({ delivered: false })
  await act(async () => {
    finish.resolve(accepted())
  })
  expect(callback).not.toHaveBeenCalled()
  expect(readOutbox(sessionId)).toHaveLength(1)
})

it('launch refusal is durably blocked for panes until explicit Retry', async () => {
  const staged = enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'launch')!
  mocks.call.mockResolvedValueOnce({
    ok: false,
    refusal: { code: 'agent_session_checkpoint_stale', message: 'refused' }
  })
  expect(await launch(staged)).toMatchObject({ delivered: false })
  const pane = mount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16000)
  })
  expect(mocks.call).toHaveBeenCalledTimes(1)
  await act(async () => {
    pane.result.current.retry(staged.clientMessageId)
  })
  expect(mocks.call).toHaveBeenCalledTimes(2)
})

it('uncertainty can still settle through recovery without ending joined observations early', async () => {
  const staged = enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'launch')!
  mocks.call.mockRejectedValueOnce(new Error('connection closed'))
  const callback = vi.fn()
  const delivery = launch(staged, callback)
  await act(async () => {})
  mount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(await delivery).toMatchObject({ delivered: true })
  expect(callback).toHaveBeenCalledTimes(1)
})

it('staging failure retires its observation without sending', () => {
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  expect(enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'launch')).toBeNull()
  expect(mocks.call).not.toHaveBeenCalled()
  spy.mockRestore()
})

it('a parked operation keeps its joined observation through same-operation Resume', async () => {
  const staged = enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'launch')!
  mocks.call.mockRejectedValue(new Error('connection closed'))
  const callback = vi.fn()
  const delivery = launch(staged, callback)
  await act(async () => {})
  const pane = mount()
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16000)
    })
  }
  expect(mocks.call).toHaveBeenCalledTimes(9)
  expect(pane.result.current.recoveryPaused).toBe(true)
  expect(callback).not.toHaveBeenCalled()
  mocks.call.mockResolvedValue(accepted())
  act(() => pane.result.current.resumeChecking(staged.clientMessageId))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(await delivery).toMatchObject({ delivered: true })
  expect(callback).toHaveBeenCalledTimes(1)
  expect(mocks.call.mock.lastCall?.[2].retryUnknown).toBeUndefined()
})

it('failed acceptance persistence does not publish acceptance and leaves the known remount limitation', async () => {
  const staged = enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'launch')!
  const finish = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValueOnce(finish.promise)
  const pane = mount()
  const callback = vi.fn()
  const delivery = launch(staged, callback)
  const spy = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
    throw new Error('quota')
  })
  await act(async () => {
    finish.resolve(accepted())
  })
  spy.mockRestore()
  expect(await delivery).toMatchObject({ delivered: false })
  expect(callback).not.toHaveBeenCalled()
  expect(pane.result.current.error).toBe('Message could not be saved to the outbox')
  expect(pane.result.current.recoveryPaused).toBe(false)
  expect(readOutbox(sessionId, false)[0].state).toBe('dispatching')
})

it('only the original staged handles can read receipts from 64 completed deliveries', async () => {
  const handles: NonNullable<ReturnType<typeof enqueueStructuredAgentSessionLaunchPrompt>>[] = []
  for (let i = 0; i < 64; i++) {
    const staged = enqueueStructuredAgentSessionLaunchPrompt(sessionId, `launch ${i}`)!
    expect(await launch(staged)).toMatchObject({ delivered: true })
    handles.push(staged)
  }
  // Receipt ownership is per handle; reconstructed entries never recover historical acceptance.
  for (const staged of handles) {
    expect(await observeOutboxSettlement(staged)).toBe('accepted')
    expect(await observeOutboxSettlement({ ...staged })).toBe('unavailable')
  }
  expect(readOutbox(sessionId)).toEqual([])
  expect(mocks.call).toHaveBeenCalledTimes(64)
})
