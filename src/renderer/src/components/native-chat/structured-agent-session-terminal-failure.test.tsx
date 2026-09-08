// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  enqueueStructuredAgentSessionLaunchPrompt as enqueue,
  discardStructuredAgentSessionLaunchOutbox as discard
} from './structured-agent-session-launch-outbox'
import { readOutbox } from './structured-agent-session-outbox-storage'
import { observeOutboxSettlement } from './structured-agent-session-outbox-settlement'
import { settleStructuredAgentLaunchPrompt as settle } from '../../lib/structured-agent-session-launch-prompt'
import {
  addStructuredLaunchCaller,
  createStructuredLaunchCallerGroup,
  settleStructuredLaunchCallersWithoutFallback,
  claimStructuredLaunchCallerFallback
} from '../../lib/structured-agent-session-launch-callers'
const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
const sessionId = 'independent-restart-edge'
const target = { kind: 'local' } as const
const empty: AgentJournalSubmission[] = []
const receipt = { sessionId, fence: 1 }
const accepted = { ok: true, value: { submission: { dispatchState: 'accepted' } } }
function mount() {
  return renderHook(
    ({ submissions }) =>
      useStructuredAgentSessionOutbox({ sessionId, target, fence: 1, submissions }),
    { initialProps: { submissions: empty } }
  )
}
function launch(stagedEntry: NonNullable<ReturnType<typeof enqueue>>, callback = vi.fn()) {
  return settle({
    stagedEntry,
    options: { prompt: 'synthetic', onPromptDelivered: callback },
    launchResult: Promise.resolve(receipt)
  })!
}
beforeEach(() => {
  localStorage.clear()
  mocks.call.mockReset().mockImplementation(() => new Promise(() => {}))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  discard(sessionId)
  vi.useRealTimers()
})

it('control: journal acceptance settles the caller with a still-pending send RPC', async () => {
  const staged = enqueue(sessionId, 'synthetic')!
  const pane = mount()
  const callback = vi.fn()
  const delivery = launch(staged, callback)
  await act(async () => {})
  pane.rerender({
    submissions: [
      {
        clientMessageId: staged.clientMessageId,
        dispatchState: 'accepted'
      } as AgentJournalSubmission
    ]
  })
  await act(async () => {})
  expect(await delivery).toMatchObject({ delivered: true })
  expect(callback).toHaveBeenCalledTimes(1)
  expect(mocks.call).toHaveBeenCalledTimes(1)
})

it('journal acceptance write failure terminates observers as unavailable just like RPC completion write failure', async () => {
  const staged = enqueue(sessionId, 'synthetic')!
  const pane = mount()
  let outcome = 'pending'
  const callback = vi.fn()
  void launch(staged, callback).then((result) => {
    outcome = result.delivered ? 'accepted' : 'unavailable'
  })
  await act(async () => {})
  const spy = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
    throw new Error('synthetic storage failure')
  })
  pane.rerender({
    submissions: [
      {
        clientMessageId: staged.clientMessageId,
        dispatchState: 'accepted'
      } as AgentJournalSubmission
    ]
  })
  await act(async () => {})
  spy.mockRestore()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160000)
  })
  expect(pane.result.current.error).toBe('Message could not be saved to the outbox')
  expect(pane.result.current.recoveryPaused).toBe(false)
  expect(readOutbox(sessionId, false)[0].state).toBe('dispatching')
  expect(callback).not.toHaveBeenCalled()
  console.log('journal-storage-failure', { outcome, calls: mocks.call.mock.calls.length })
  expect(outcome).toBe('unavailable')
})

it('control: failed RPC acceptance persistence settles unavailable without a hanging caller', async () => {
  const staged = enqueue(sessionId, 'synthetic')!
  const response = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValue(response.promise)
  mount()
  const delivery = launch(staged)
  await act(async () => {})
  const spy = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
    throw new Error('synthetic storage failure')
  })
  await act(async () => {
    response.resolve(accepted)
  })
  spy.mockRestore()
  expect(await delivery).toMatchObject({ delivered: false })
  expect(await observeOutboxSettlement(staged)).toBe('unavailable')
})

it('failed discard terminates waiting launch observers without claiming acceptance', async () => {
  const staged = enqueue(sessionId, 'synthetic')!
  let outcome = 'pending'
  void launch(staged).then((result) => {
    outcome = result.delivered ? 'accepted' : 'unavailable'
  })
  await act(async () => {})
  const spy = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
    throw new Error('synthetic storage failure')
  })
  expect(discard(sessionId)).toBe(false)
  spy.mockRestore()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160000)
  })
  expect(readOutbox(sessionId, false)).toHaveLength(1)
  expect(outcome).toBe('unavailable')
})

it('completed caller registrations retire while a subsequent operation keeps the launch group live', async () => {
  const group = createStructuredLaunchCallerGroup()
  settleStructuredLaunchCallersWithoutFallback(group, 'published')
  const responses: ReturnType<typeof Promise.withResolvers<unknown>>[] = []
  mocks.call.mockImplementation(() => {
    const response = Promise.withResolvers<unknown>()
    responses.push(response)
    return response.promise
  })
  function join() {
    const stagedEntry = enqueue(sessionId, 'synthetic')!
    const caller = addStructuredLaunchCaller({
      group,
      launchResult: Promise.resolve(receipt),
      options: { prompt: 'synthetic' },
      stagedEntry
    })
    void claimStructuredLaunchCallerFallback(group, caller, () => ({
      delivered: false,
      failureNotified: false
    }))
    return caller
  }
  const held: ReturnType<typeof join>[] = []
  let current = join()
  await act(async () => {})
  for (let i = 0; i < 64; i++) {
    const next = join()
    await act(async () => {
      responses[i].resolve(accepted)
    })
    expect(await current.promptDeliveryResult).toMatchObject({ delivered: true })
    held.push(current)
    current = next
  }
  mocks.call.mockRejectedValue(new Error('connection closed'))
  await act(async () => {
    responses[64].resolve({ ok: true, value: { submission: { dispatchState: 'unknown' } } })
  })
  const pane = mount()
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16000)
    })
  }
  expect(pane.result.current.recoveryPaused).toBe(true)
  expect(group.promptDeliveryResults.size).toBe(1)
  expect(readOutbox(sessionId, false)).toHaveLength(1)
  const retainedCallbacks = [...group.entries].filter(
    (caller) => caller.refusalFallback.callback !== null
  ).length
  console.log('caller-retention', {
    registrations: group.entries.size,
    retainedCallbacks,
    activeResults: group.promptDeliveryResults.size,
    calls: mocks.call.mock.calls.length
  })
  expect(group.entries.size).toBe(1)
  expect(retainedCallbacks).toBe(0)
  for (const caller of held) {
    expect(caller.refusalFallback.callback).toBe(null)
    expect(await caller.promptDeliveryResult).toMatchObject({ delivered: true })
  }
})

it('a finite unknown RPC after failed journal acceptance cannot strand an already-accepted operation', async () => {
  const staged = enqueue(sessionId, 'synthetic')!
  const response = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValue(response.promise)
  const pane = mount()
  let outcome = 'pending'
  void launch(staged).then((result) => {
    outcome = result.delivered ? 'accepted' : 'unavailable'
  })
  await act(async () => {})
  const spy = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
    throw new Error('synthetic storage failure')
  })
  pane.rerender({
    submissions: [
      {
        clientMessageId: staged.clientMessageId,
        dispatchState: 'accepted'
      } as AgentJournalSubmission
    ]
  })
  spy.mockRestore()
  await act(async () => {
    response.resolve({ ok: true, value: { submission: { dispatchState: 'unknown' } } })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160000)
  })
  expect(pane.result.current.error).toBe(null)
  expect(pane.result.current.recoveryPaused).toBe(false)
  expect(readOutbox(sessionId, false)[0].state).toBe('unconfirmed')
  expect(mocks.call).toHaveBeenCalledTimes(1)
  console.log('finite-journal-storage-failure', {
    outcome,
    error: pane.result.current.error,
    recoveryPaused: pane.result.current.recoveryPaused
  })
  expect(outcome).not.toBe('pending')
})
