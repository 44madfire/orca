import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

function ok(result: unknown) {
  return { ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function snapshotEvent(items: AgentJournalRenderItem[]): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence: 3,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence: 3,
      direction: 'tail',
      items,
      removedItemIds: [],
      submissions: [],
      window: {
        oldest: null,
        newest: null,
        nextCursor: { epoch: 'epoch-1', sequence: 0 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: 0 },
      hasOlder: false,
      hasNewer: false
    }
  }
}

function user(itemId: string, sequence: number, observedAt: number): AgentJournalRenderItem {
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }] }
  }
}

async function sendRequest(method: string) {
  if (method === 'agentSession.options') {
    return ok({
      models: [
        {
          id: 'gpt-fast',
          label: 'GPT Fast',
          isDefault: true,
          defaultEffort: 'low',
          efforts: [{ value: 'low', label: 'Low' }]
        }
      ],
      current: { model: 'gpt-fast', effort: 'low' }
    })
  }
  return ok({})
}

describe('useMobileStructuredAgentSession turn timing', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    listener = onData
    return vi.fn()
  })
  const client = { sendRequest: vi.fn(sendRequest), subscribe } as unknown as RpcClient

  function Harness(): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      agent: 'codex',
      onSendError: vi.fn()
    } as never)
    return null
  }

  beforeEach(() => {
    listener = null
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    vi.useRealTimers()
  })

  it('exposes host-settled durations and a skew-free live anchor', async () => {
    vi.setSystemTime(50_000)
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() =>
      listener?.(
        snapshotEvent([
          user('u1', 1, 9_000_000),
          {
            itemId: 'l1',
            revision: 1,
            sequence: 2,
            observedAt: 9_000_100,
            body: {
              kind: 'status',
              text: 'Done',
              turnLifecycle: {
                turnId: 't1',
                state: 'completed',
                startedAt: 9_000_000,
                completedAt: 9_004_000
              }
            }
          },
          user('u2', 3, 9_010_000),
          {
            itemId: 'l2',
            revision: 1,
            sequence: 4,
            observedAt: 9_010_300,
            body: {
              kind: 'status',
              text: 'Working',
              turnLifecycle: { turnId: 't2', state: 'running', startedAt: 9_010_000 }
            }
          }
        ])
      )
    )
    expect(hook?.isWorking).toBe(true)
    const anchor = hook!.workingStartedAt
    // Client clock (50s) is nowhere near the host's (9,010s): only the 300ms append lag moves it.
    expect(anchor).toBe(Date.now() - 300)
    expect([...hook!.settledTurns]).toEqual([['u1', { startedAt: 9_000_000, workedSeconds: 4 }]])
    vi.setSystemTime(Date.now() + 30_000)
    act(() => renderer?.update(createElement(Harness)))
    expect(hook?.workingStartedAt).toBe(anchor)
  })
})
