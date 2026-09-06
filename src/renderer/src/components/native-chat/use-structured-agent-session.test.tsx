// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn(), operationId: vi.fn() }))
let fence = 3
let commandsRevision: number | undefined

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence,
      commandsRevision,
      items: [],
      submissions: [],
      status: 'ready',
      error: null,
      hasOlder: false,
      handoff: null
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: mocks.operationId,
  useStructuredAgentSessionOutbox: () => ({
    outbox: [],
    blockedClientMessageId: null,
    error: null,
    send: vi.fn(),
    retry: vi.fn()
  })
}))

import { useStructuredAgentSession } from './use-structured-agent-session'

const LOCAL_TARGET = { kind: 'local' } as const

const OPTIONS = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    },
    {
      id: 'gpt-fast',
      label: 'GPT Fast',
      isDefault: false,
      defaultEffort: 'low',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' }
      ]
    }
  ],
  current: { model: 'gpt-live', effort: 'medium' }
}

describe('useStructuredAgentSession options', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    mocks.operationId
      .mockReset()
      .mockReturnValueOnce('operation-1')
      .mockReturnValueOnce('operation-2')
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options' ? Promise.resolve(OPTIONS) : Promise.resolve(null)
    )
  })

  it('applies provider-reconciled values after a model change', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.resolve({
            ok: true,
            value: {
              key: 'model',
              value: 'gpt-fast',
              options: { model: 'gpt-fast', effort: 'low' }
            }
          })
    )
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })

    expect(result.current.optionSnapshot.find((entry) => entry.id === 'model')?.kind).toMatchObject(
      {
        currentValue: 'gpt-fast'
      }
    )
    expect(
      result.current.optionSnapshot.find((entry) => entry.id === 'effort')?.kind
    ).toMatchObject({
      currentValue: 'low'
    })
  })

  it('surfaces a rejected option transport call and clears pending state', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.reject(new Error('provider rejected option'))
    )
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(false)
    })

    expect(result.current.error).toBe('provider rejected option')
    expect(result.current.optionSnapshot.find((entry) => entry.id === 'model')).toMatchObject({
      settable: true
    })
  })

  it('mints a fresh operation when the same option is retried after a typed refusal', async () => {
    let attempts = 0
    mocks.call.mockImplementation((_target, method) => {
      if (method !== 'agentSession.setOption') {
        // The hook also holds the session while it is mounted; only option writes are attempts.
        return Promise.resolve(method === 'agentSession.options' ? OPTIONS : null)
      }
      attempts += 1
      return Promise.resolve(
        attempts === 1
          ? {
              ok: false,
              refusal: {
                code: 'agent_session_operation_invalid',
                message: 'model list unavailable'
              }
            }
          : {
              ok: true,
              value: {
                key: 'model',
                value: 'gpt-fast',
                options: { model: 'gpt-fast', effort: 'low' }
              }
            }
      )
    })
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(false)
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })

    const mutations = mocks.call.mock.calls.filter(
      ([, method]) => method === 'agentSession.setOption'
    )
    expect(
      mutations.map(
        ([, , params]) =>
          (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
      )
    ).toEqual(['operation-1', 'operation-2'])
  })

  it('reuses an option operation after a pending admission refusal', async () => {
    let attempts = 0
    mocks.call.mockImplementation((_target, method) => {
      if (method !== 'agentSession.setOption') {
        // The hook also holds the session while it is mounted; only option writes are attempts.
        return Promise.resolve(method === 'agentSession.options' ? OPTIONS : null)
      }
      attempts += 1
      return Promise.resolve(
        attempts === 1
          ? {
              ok: false,
              refusal: {
                code: 'agent_session_checkpoint_stale',
                message: 'runtime fence advanced',
                currentFence: 4
              }
            }
          : {
              ok: true,
              replayed: false,
              value: {
                key: 'model',
                value: 'gpt-fast',
                options: { model: 'gpt-fast', effort: 'low' }
              }
            }
      )
    })
    const { result, rerender } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(false)
    })
    fence = 4
    rerender()
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))
    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })

    const mutations = mocks.call.mock.calls.filter(
      ([, method]) => method === 'agentSession.setOption'
    )
    expect(
      mutations.map(
        ([, , params]) =>
          (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
      )
    ).toEqual(['operation-1', 'operation-1'])
    expect(
      mutations.map(
        ([, , params]) =>
          (params as { envelope: { expectedRuntimeFence: number } }).envelope.expectedRuntimeFence
      )
    ).toEqual([3, 4])
    expect(mocks.operationId).toHaveBeenCalledTimes(1)
  })

  it('ignores an option failure from a superseded fence', async () => {
    let reject!: (error: Error) => void
    const pending = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise
    })
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options' ? Promise.resolve(OPTIONS) : pending
    )
    const { result, rerender } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))
    let setting!: Promise<boolean>
    act(() => {
      setting = result.current.setStructuredOption('model', 'gpt-fast')
    })
    fence = 4
    rerender()

    await act(async () => {
      reject(new Error('stale provider failure'))
      await setting
    })

    expect(result.current.error).toBeNull()
  })

  it('includes one background task id in the cancel fingerprint and payload', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.resolve({
            ok: true,
            value: { turnId: 'background-tasks', cancelled: true }
          })
    )
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'claude',
        isVisible: true
      })
    )

    await act(async () => {
      await expect(result.current.stopBackgroundTask('task-2')).resolves.toMatchObject({
        cancelled: true
      })
    })

    const mutation = mocks.call.mock.calls.find(([, method]) => method === 'agentSession.cancel')
    expect(mutation?.[2]).toMatchObject({
      envelope: {
        sessionId: 'session-1',
        expectedRuntimeFence: 3
      },
      turnId: 'background-tasks',
      scope: 'background-tasks',
      taskId: 'task-2'
    })
  })
})

describe('session command catalog reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    commandsRevision = 0
  })

  const args = { sessionId: 'one', target: LOCAL_TARGET, agent: 'claude' as const, isVisible: true }
  const commands = [{ name: 'plugin:review', kind: 'skill' as const }]
  function respond(read: (params: { sessionId: string }) => Promise<unknown>) {
    mocks.call.mockImplementation((_target, method, params) =>
      method === 'agentSession.commands'
        ? read(params)
        : Promise.resolve(method === 'agentSession.options' ? OPTIONS : null)
    )
  }

  it('clears previous session data before a new read settles or fails', async () => {
    let reject!: (error: Error) => void
    respond(({ sessionId }) =>
      sessionId === 'one'
        ? Promise.resolve({ commands })
        : new Promise((_resolve, rejectPromise) => {
            reject = rejectPromise
          })
    )
    const { result, rerender } = renderHook((props) => useStructuredAgentSession(props), {
      initialProps: args
    })
    await waitFor(() => expect(result.current.sessionCommands).toEqual(commands))
    rerender({ ...args, sessionId: 'two' })
    expect(result.current.sessionCommands).toBeUndefined()
    await act(async () => reject(new Error('method_not_found')))
    expect(result.current.sessionCommands).toBeUndefined()
  })

  it('does not reuse a catalog for the same session id on another paired runtime', async () => {
    const first = { kind: 'environment' as const, environmentId: 'first' }
    const second = { kind: 'environment' as const, environmentId: 'second' }
    mocks.call.mockImplementation((target, method) => {
      if (method === 'agentSession.commands') {
        return target === first ? Promise.resolve({ commands }) : new Promise(() => {})
      }
      return Promise.resolve(method === 'agentSession.options' ? OPTIONS : null)
    })
    const { result, rerender } = renderHook(
      (target) => useStructuredAgentSession({ ...args, target }),
      { initialProps: first }
    )
    await waitFor(() => expect(result.current.sessionCommands).toEqual(commands))
    rerender(second)
    expect(result.current.sessionCommands).toBeUndefined()
  })

  it('drops responses from a superseded session and retains authoritative empty responses', async () => {
    let resolve!: (value: unknown) => void
    respond(({ sessionId }) =>
      sessionId === 'one'
        ? new Promise((resolvePromise) => {
            resolve = resolvePromise
          })
        : Promise.resolve({ commands: [] })
    )
    const { result, rerender } = renderHook((props) => useStructuredAgentSession(props), {
      initialProps: args
    })
    rerender({ ...args, sessionId: 'two' })
    await waitFor(() => expect(result.current.sessionCommands).toEqual([]))
    await act(async () => resolve({ commands }))
    expect(result.current.sessionCommands).toEqual([])
  })

  it('refreshes an idle catalog only on revision changes, not transcript renders', async () => {
    let current = commands
    respond(async () => ({ commands: current }))
    const { result, rerender } = renderHook(() => useStructuredAgentSession(args))
    await waitFor(() => expect(result.current.sessionCommands).toEqual(commands))
    const reads = () =>
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.commands').length
    for (let index = 0; index < 30; index += 1) {
      rerender()
    }
    expect(reads()).toBe(1)
    current = []
    commandsRevision = 1
    rerender()
    await waitFor(() => expect(result.current.sessionCommands).toEqual([]))
    expect(reads()).toBe(2)
  })

  it('falls back after a current catalog read failure and fences reacquisition', async () => {
    respond(async () => ({ commands }))
    const { result, rerender } = renderHook(() => useStructuredAgentSession(args))
    await waitFor(() => expect(result.current.sessionCommands).toEqual(commands))
    respond(async () => {
      throw new Error('unreachable')
    })
    commandsRevision = 1
    rerender()
    await waitFor(() => expect(result.current.sessionCommands).toBeUndefined())
    respond(() => new Promise(() => {}))
    fence = 4
    rerender()
    expect(result.current.sessionCommands).toBeUndefined()
  })
})
