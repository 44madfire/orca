import type { AgentJournalTurnTiming } from './agent-session-journal-types'

export function readAgentJournalTurnTiming(value: unknown): AgentJournalTurnTiming | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const timing = value as AgentJournalTurnTiming
  if (typeof timing.userItemId !== 'string' || !timing.userItemId) {
    return undefined
  }
  const valid = (endpoint: AgentJournalTurnTiming['start']): boolean =>
    endpoint === undefined ||
    (endpoint !== null &&
      Number.isFinite(endpoint.at) &&
      endpoint.at > 0 &&
      (endpoint.source === 'provider' || endpoint.source === 'host') &&
      (endpoint.clock === undefined ||
        (typeof endpoint.clock === 'string' && endpoint.clock.length > 0)))
  return valid(timing.start) && valid(timing.end) ? timing : undefined
}

export function mergeAgentJournalTurnTiming(
  current: AgentJournalTurnTiming | undefined,
  incoming: AgentJournalTurnTiming
): AgentJournalTurnTiming {
  const choose = (prior: AgentJournalTurnTiming['start'], next: AgentJournalTurnTiming['start']) =>
    next?.source === 'provider'
      ? {
          ...next,
          ...(next.clock === undefined &&
          prior?.at === next.at &&
          prior.source === next.source &&
          prior.clock
            ? { clock: prior.clock }
            : {})
        }
      : (prior ?? next)
  return {
    userItemId: incoming.userItemId,
    start: choose(current?.start, incoming.start),
    end: choose(current?.end, incoming.end)
  }
}

export function completedAgentJournalTurnSeconds(
  timing: AgentJournalTurnTiming | undefined
): number | null {
  const valid = readAgentJournalTurnTiming(timing)
  const start = valid?.start?.at
  const end = valid?.end?.at
  return start !== undefined &&
    end !== undefined &&
    (valid?.start?.source === valid?.end?.source ||
      (valid?.start?.clock !== undefined && valid.start.clock === valid.end?.clock)) &&
    !(valid?.start?.clock && valid?.end?.clock && valid.start.clock !== valid.end.clock) &&
    !(
      valid?.start?.source === 'host' &&
      valid?.end?.source === 'host' &&
      (valid.start.clock || valid.end.clock) &&
      valid.start.clock !== valid.end.clock
    ) &&
    end >= start
    ? Math.floor((end - start) / 1000)
    : null
}
