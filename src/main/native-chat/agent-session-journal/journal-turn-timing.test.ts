import { describe, expect, it } from 'vitest'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { applyJournalTurnTiming, MAX_PENDING_JOURNAL_TURN_TIMINGS } from './journal-turn-timing'
import type { AgentJournalTurnTiming } from '../../../shared/agent-session-journal-types'

const timing: AgentJournalTurnTiming = {
  userItemId: 'claude:s:u',
  start: { at: 1000, source: 'host' },
  end: { at: 188000, source: 'host' }
}
const base = { v: 2, epoch: 'epoch', fence: 1, ts: 1 }
describe('journal timing association lifecycle', () => {
  it('bounds unmatched identities and releases a failed turn without inventing completion', () => {
    const state = createJournalReducerState('s', 'epoch')
    for (let i = 0; i < MAX_PENDING_JOURNAL_TURN_TIMINGS + 10; i++) {
      applyJournalTurnTiming(state, { ...timing, userItemId: `missing-${i}` })
    }
    expect(state.pendingTurnTimings.size).toBe(MAX_PENDING_JOURNAL_TURN_TIMINGS)
    expect(state.pendingTurnTimings.has('missing-0')).toBe(false)
    applyJournalRow(state, {
      ...base,
      kind: 'item',
      seq: 1,
      itemId: 'lifecycle',
      revision: 1,
      body: { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'u', state: 'running' } },
      turnTiming: { ...timing, end: undefined }
    })
    expect(state.pendingTurnTimings.has(timing.userItemId)).toBe(true)
    applyJournalRow(state, { ...base, kind: 'tombstone', seq: 2, itemId: 'lifecycle', revision: 2 })
    expect(state.pendingTurnTimings.has(timing.userItemId)).toBe(false)
    expect(state.items.size).toBe(0)
  })
  it('updates only the associated user item and keeps duplicate timing referentially stable', () => {
    const state = createJournalReducerState('s', 'epoch')
    applyJournalRow(state, {
      ...base,
      kind: 'item',
      seq: 1,
      itemId: timing.userItemId,
      revision: 1,
      body: { kind: 'message', role: 'user', blocks: [] }
    })
    applyJournalTurnTiming(state, timing)
    const item = state.items.get(timing.userItemId)
    state.pendingTurnTimings.set(timing.userItemId, timing)
    applyJournalTurnTiming(state, timing)
    expect(state.items.get(timing.userItemId)).toBe(item)
    expect(state.pendingTurnTimings.size).toBe(0)
    expect(state.items.get('claude:other:u')).toBeUndefined()
  })
})

it('keeps old-host content revisions and tombstones independent of timing updates', () => {
  const state = createJournalReducerState('s', 'epoch')
  applyJournalRow(state, {
    ...base,
    kind: 'item',
    seq: 1,
    itemId: timing.userItemId,
    revision: 1,
    body: { kind: 'message', role: 'user', blocks: [] }
  })
  applyJournalTurnTiming(state, timing)
  applyJournalTurnTiming(state, { ...timing, end: { at: 190000, source: 'provider' } })
  expect(state.items.get(timing.userItemId)?.revision).toBe(1)
  applyJournalRow(state, {
    ...base,
    kind: 'tombstone',
    seq: 2,
    itemId: timing.userItemId,
    revision: 2
  })
  expect(state.items.has(timing.userItemId)).toBe(false)
})
