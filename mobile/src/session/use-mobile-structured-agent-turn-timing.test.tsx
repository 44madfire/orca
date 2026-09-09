import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'

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

type Timing = ReturnType<typeof useMobileStructuredAgentTurnTiming>

describe('useMobileStructuredAgentTurnTiming', () => {
  let renderer: ReactTestRenderer | null = null
  let timing: Timing | null = null

  function Harness({
    items,
    turnId
  }: {
    items: readonly AgentJournalRenderItem[]
    turnId: string | null
  }): null {
    timing = useMobileStructuredAgentTurnTiming(items, turnId)
    return null
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    timing = null
    vi.useRealTimers()
  })

  it('hands settled host durations through keyed by user message', () => {
    const items = [
      user('u1', 1),
      lifecycle(
        't1',
        2,
        { state: 'interrupted', startedAt: HOST_START, completedAt: HOST_START + 61_000 },
        HOST_START + 5
      )
    ]
    act(() => {
      renderer = create(createElement(Harness, { items, turnId: null }))
    })
    expect(timing?.workingStartedAt).toBeNull()
    expect([...timing!.settledTurns]).toEqual([
      ['u1', { startedAt: HOST_START, workedSeconds: 61 }]
    ])
  })

  it('anchors the live counter on the local clock, once per turn, free of host skew', () => {
    vi.useFakeTimers()
    vi.setSystemTime(CLIENT_NOW)
    const running = [
      user('u1', 1),
      lifecycle('t1', 2, { state: 'running', startedAt: HOST_START }, HOST_START + 2_500)
    ]
    act(() => {
      renderer = create(createElement(Harness, { items: running, turnId: 't1' }))
    })
    expect(timing?.workingStartedAt).toBe(CLIENT_NOW - 2_500)

    vi.setSystemTime(CLIENT_NOW + 30_000)
    act(() => renderer?.update(createElement(Harness, { items: [...running], turnId: 't1' })))
    expect(timing?.workingStartedAt).toBe(CLIENT_NOW - 2_500)

    act(() => renderer?.update(createElement(Harness, { items: running, turnId: null })))
    expect(timing?.workingStartedAt).toBeNull()
  })

  it('leaves the anchor null when an older host records no start', () => {
    vi.useFakeTimers()
    vi.setSystemTime(CLIENT_NOW)
    const items = [user('u1', 1), lifecycle('t1', 2, { state: 'running' }, HOST_START)]
    act(() => {
      renderer = create(createElement(Harness, { items, turnId: 't1' }))
    })
    expect(timing?.workingStartedAt).toBeNull()
    expect(timing?.settledTurns.size).toBe(0)
  })
})
