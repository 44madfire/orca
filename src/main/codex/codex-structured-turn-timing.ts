import { createHash } from 'node:crypto'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalTurnTiming } from '../../shared/agent-session-journal-types'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'

export function codexStructuredTurnTiming(
  threadId: string,
  turnId: string,
  params: unknown,
  edge?: 'start' | 'end',
  observedAt?: number,
  clock?: string
): AgentJournalTurnTiming {
  const turn = readCodexJournalRecord(readCodexJournalRecord(params).turn)
  const endpoint = (value: unknown): AgentJournalTurnTiming['start'] =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? { at: value * 1000, source: 'provider' }
      : undefined
  const timing: AgentJournalTurnTiming = {
    userItemId: agentJournalItemKey({ provider: 'codex', threadId, turnId, ordinal: 0 }),
    start: endpoint(turn.startedAt),
    end: endpoint(turn.completedAt)
  }
  if (
    edge &&
    turn[edge === 'start' ? 'startedAt' : 'completedAt'] == null &&
    !timing[edge] &&
    observedAt !== undefined &&
    Number.isFinite(observedAt) &&
    observedAt > 0
  ) {
    timing[edge] = { at: observedAt, source: 'host' }
  }
  if (edge && timing[edge] && clock) {
    timing[edge] = { ...timing[edge], clock }
  }
  return timing
}

export function codexTurnTimingSettlementKey(timing: AgentJournalTurnTiming | undefined): string {
  return timing && (timing.start || timing.end)
    ? `:${createHash('sha256').update(JSON.stringify(timing)).digest('hex')}`
    : ''
}

export function codexTurnTimingNeedsObservation(method: string, params: unknown): boolean {
  const field =
    method === 'turn/started' ? 'startedAt' : method === 'turn/completed' ? 'completedAt' : null
  return (
    field !== null && readCodexJournalRecord(readCodexJournalRecord(params).turn)[field] == null
  )
}
