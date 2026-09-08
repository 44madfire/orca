// @vitest-environment happy-dom
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createStructuredAgentSessionOutboxEntry,
  structuredAgentSessionSendRequest
} from '../../../../shared/structured-agent-session-outbox'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'
import { transitionOutboxEntry } from './structured-agent-session-outbox-transitions'
const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
const sessionId = 'mounted-recovery'
const target = { kind: 'local' } as const
const submissions: AgentJournalSubmission[] = []
function mount() {
  return renderHook(() =>
    useStructuredAgentSessionOutbox({ sessionId, target, fence: 1, submissions })
  )
}
const storageFaults: { mockRestore: () => void }[] = []
function failStorage(method: 'getItem' | 'setItem') {
  const fault = vi.spyOn(localStorage, method).mockImplementation(() => {
    throw new Error('synthetic persistence failure')
  })
  storageFaults.push(fault)
  return fault
}
let finish!: (value: unknown) => void
beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  mocks.call.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  writeOutbox(sessionId, [
    {
      ...createStructuredAgentSessionOutboxEntry({
        sessionId,
        clientMessageId: 'op',
        text: 'preserve',
        attachments: [],
        queuedAt: 1
      }),
      recovery: { attempts: 3, nextProbeAt: null, parkedReason: null }
    }
  ])
})
afterEach(() => {
  for (const fault of storageFaults.splice(0)) {
    fault.mockRestore()
  }
  vi.restoreAllMocks()
  cleanup()
  vi.useRealTimers()
})
it.each(['read', 'write'] as const)(
  'recovers a failed completion %s through mounted Resume with saved allowance',
  async (fault) => {
    const first = mount()
    const second = mount()
    expect(first.result.current.recoveryPaused).toBe(false)
    const saved = readOutbox(sessionId, false)[0]
    const failure = failStorage(fault === 'read' ? 'getItem' : 'setItem')
    await act(async () => {
      finish({ ok: true, value: { submission: { dispatchState: 'unknown' } } })
    })
    expect(first.result.current.recoveryPaused).toBe(true)
    expect(second.result.current.recoveryPaused).toBe(true)
    expect(first.result.current.outbox[0].state).toBe('dispatching')
    act(() => first.result.current.resumeChecking('op'))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(first.result.current.recoveryPaused).toBe(true)
    failure.mockRestore()
    act(() => {
      first.result.current.resumeChecking('op')
      second.result.current.resumeChecking('op')
    })
    const reserved = readOutbox(sessionId, false)[0]
    expect(reserved).toMatchObject({
      clientMessageId: saved.clientMessageId,
      body: saved.body,
      state: 'unconfirmed',
      recovery: { attempts: 4 }
    })
    expect(mocks.call).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000)
    })
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(mocks.call.mock.calls[1][2]).toEqual(structuredAgentSessionSendRequest(saved, 1))
    expect(mocks.call.mock.calls[1][2].retryUnknown).toBeUndefined()
    expect(first.result.current.recoveryPaused).toBe(false)
  }
)
it('does not recover a live claim or let stale completion erase its replacement', async () => {
  const first = mount()
  const oldFinish = finish
  const second = mount()
  act(() => {
    first.result.current.resumeChecking('op')
    second.result.current.resumeChecking('op')
  })
  expect(mocks.call).toHaveBeenCalledTimes(1)
  expect(first.result.current.recoveryPaused).toBe(false)
  const original = readOutbox(sessionId, false)[0]
  act(() => {
    transitionOutboxEntry(original, (current) => ({
      ...current,
      deliveryIncarnation: 1,
      state: 'queued'
    }))
  })
  expect(mocks.call).toHaveBeenCalledTimes(2)
  await act(async () => {
    oldFinish({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
  })
  expect(readOutbox(sessionId, false)[0]).toMatchObject({
    deliveryIncarnation: 1,
    state: 'dispatching'
  })
  expect(second.result.current.recoveryPaused).toBe(false)
})

it('a previously blocked Resume handler cannot reclaim a successor live dispatch', async () => {
  const first = mount()
  const second = mount()
  const failure = failStorage('setItem')
  await act(async () => {
    finish({ ok: true, value: { submission: { dispatchState: 'unknown' } } })
  })
  act(() => first.result.current.resumeChecking('op'))
  const staleResume = first.result.current.resumeChecking
  failure.mockRestore()
  act(() => second.result.current.resumeChecking('op'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000)
  })
  const before = readOutbox(sessionId, false)
  expect(before[0].state).toBe('dispatching')
  act(() => staleResume('op'))
  expect(readOutbox(sessionId, false)).toEqual(before)
  expect(mocks.call).toHaveBeenCalledTimes(2)
})

it('notifies a mounted pane when a launch-owned completion loses persistence and releases its claim', async () => {
  const { enqueueStructuredAgentSessionLaunchPrompt } =
    await import('./structured-agent-session-launch-outbox')
  const { settleStructuredAgentLaunchPrompt } =
    await import('@/lib/structured-agent-session-launch-prompt')
  writeOutbox(sessionId, [])
  const staged = enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'launch-owned')!
  const delivered = settleStructuredAgentLaunchPrompt({
    launchResult: Promise.resolve({ sessionId, fence: 1 }),
    options: { prompt: 'launch-owned' },
    stagedEntry: staged
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(mocks.call).toHaveBeenCalledTimes(1)
  const pane = mount()
  expect(pane.result.current.recoveryPaused).toBe(false)
  const failure = failStorage('setItem')
  await act(async () => {
    finish({ ok: true, value: { submission: { dispatchState: 'unknown' } } })
  })
  expect(await delivered).toMatchObject({ delivered: false })
  expect(pane.result.current.error).toBeNull()
  expect(pane.result.current.recoveryPaused).toBe(true)
  failure.mockRestore()
  act(() => pane.result.current.resumeChecking(staged.clientMessageId))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(mocks.call).toHaveBeenCalledTimes(2)
  expect(mocks.call.mock.calls[1][2].retryUnknown).toBeUndefined()
})
