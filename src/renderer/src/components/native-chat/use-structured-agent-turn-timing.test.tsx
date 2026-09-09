// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { useStructuredAgentTurnTiming } from './use-structured-agent-turn-timing'

// Host clock sits an hour ahead of the client's so any leak of a host timestamp
// into the local anchor shows up as a huge offset.
const HOST_START = 3_600_000_000
const CLIENT_NOW = 12_345_000

function user(itemId: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: HOST_START + sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }] }
  }
}

function lifecycle(
  turnId: string,
  sequence: number,
  turnLifecycle: Omit<
    NonNullable<Extract<AgentJournalRenderItem['body'], { kind: 'status' }>['turnLifecycle']>,
    'turnId'
  >,
  observedAt: number
): AgentJournalRenderItem {
  return {
    itemId: `lifecycle-${turnId}`,
    revision: 1,
    sequence,
    observedAt,
    body: { kind: 'status', text: 'Working', turnLifecycle: { turnId, ...turnLifecycle } }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useStructuredAgentTurnTiming', () => {
  it('hands settled host durations through keyed by user message', () => {
    const items = [
      user('u1', 1),
      lifecycle(
        't1',
        2,
        { state: 'completed', startedAt: HOST_START, completedAt: HOST_START + 197_900 },
        HOST_START + 5
      )
    ]
    const { result } = renderHook(() => useStructuredAgentTurnTiming(items, null))
    expect(result.current.workingStartedAt).toBeNull()
    expect([...result.current.settledTurns]).toEqual([
      ['u1', { startedAt: HOST_START, workedSeconds: 197 }]
    ])
  })

  it('anchors the live counter on the local clock, once per turn, free of host skew', () => {
    vi.useFakeTimers()
    vi.setSystemTime(CLIENT_NOW)
    // The host appended the row 2.5s after it saw the turn start.
    const running = [
      user('u1', 1),
      lifecycle('t1', 2, { state: 'running', startedAt: HOST_START }, HOST_START + 2_500)
    ]
    const { result, rerender } = renderHook(
      ({ items, turnId }: { items: AgentJournalRenderItem[]; turnId: string | null }) =>
        useStructuredAgentTurnTiming(items, turnId),
      { initialProps: { items: running, turnId: 't1' as string | null } }
    )
    expect(result.current.workingStartedAt).toBe(CLIENT_NOW - 2_500)

    vi.setSystemTime(CLIENT_NOW + 30_000)
    rerender({ items: [...running], turnId: 't1' })
    expect(result.current.workingStartedAt).toBe(CLIENT_NOW - 2_500)

    rerender({ items: running, turnId: null })
    expect(result.current.workingStartedAt).toBeNull()

    vi.setSystemTime(CLIENT_NOW + 60_000)
    const next = [
      ...running,
      user('u2', 3),
      lifecycle('t2', 4, { state: 'running', startedAt: HOST_START + 50_000 }, HOST_START + 50_100)
    ]
    rerender({ items: next, turnId: 't2' })
    expect(result.current.workingStartedAt).toBe(CLIENT_NOW + 60_000 - 100)
  })

  it('leaves the anchor null when an older host records no start', () => {
    vi.useFakeTimers()
    vi.setSystemTime(CLIENT_NOW)
    const items = [user('u1', 1), lifecycle('t1', 2, { state: 'running' }, HOST_START)]
    const { result } = renderHook(() => useStructuredAgentTurnTiming(items, 't1'))
    expect(result.current.workingStartedAt).toBeNull()
    expect(result.current.settledTurns.size).toBe(0)
  })
})
