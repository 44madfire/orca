import type { AgentJournalTurnTiming } from '../../../shared/agent-session-journal-types'
import {
  mergeAgentJournalTurnTiming,
  readAgentJournalTurnTiming
} from '../../../shared/agent-session-turn-timing'
import type { JournalReducerState } from './journal-reducer'

export const MAX_PENDING_JOURNAL_TURN_TIMINGS = 256

/** Endpoints may arrive before the provider acknowledges the submitted user item. */
export function applyJournalTurnTiming(state: JournalReducerState, value: unknown): void {
  const incoming = readAgentJournalTurnTiming(value)
  if (!incoming) {
    return
  }
  const key = incoming.userItemId
  const itemId = state.aliases.get(key) ?? key
  const item = state.items.get(itemId)
  const current = item?.turnTiming ?? state.pendingTurnTimings.get(key)
  const timing = mergeAgentJournalTurnTiming(current, incoming)
  if (
    current?.start?.clock === timing.start?.clock &&
    current?.end?.clock === timing.end?.clock &&
    current?.start?.at === timing.start?.at &&
    current?.start?.source === timing.start?.source &&
    current?.end?.at === timing.end?.at &&
    current?.end?.source === timing.end?.source &&
    item?.turnTiming
  ) {
    state.pendingTurnTimings.delete(key)
    return
  }
  if (item?.body.kind === 'message' && item.body.role === 'user') {
    state.items.set(itemId, { ...item, turnTiming: timing, turnTimingSequence: state.lastSequence })
    state.pendingTurnTimings.delete(key)
    return
  }
  state.pendingTurnTimings.set(key, timing)
  if (state.pendingTurnTimings.size > MAX_PENDING_JOURNAL_TURN_TIMINGS) {
    const oldest = state.pendingTurnTimings.keys().next().value
    if (oldest !== undefined) {
      state.pendingTurnTimings.delete(oldest)
    }
  }
}

export function associateJournalTurnTiming(state: JournalReducerState, userItemId: string): void {
  const timing: AgentJournalTurnTiming | undefined =
    state.pendingTurnTimings.get(userItemId) ?? state.items.get(userItemId)?.turnTiming
  if (timing) {
    applyJournalTurnTiming(state, timing)
  }
}
