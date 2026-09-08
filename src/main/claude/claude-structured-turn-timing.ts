import type { AgentJournalTurnTiming } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

export function claudeTurnEndpoint(
  message: Record<string, unknown>,
  observedAt?: number,
  clock?: string
): AgentJournalTurnTiming['start'] {
  const at = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : Number.NaN
  if (Number.isFinite(at) && at > 0) {
    return { at, source: 'provider', ...(clock ? { clock } : {}) }
  }
  if (message.timestamp != null) {
    return undefined
  }
  return observedAt !== undefined && Number.isFinite(observedAt) && observedAt > 0
    ? { at: observedAt, source: 'host', ...(clock ? { clock } : {}) }
    : undefined
}

export function publishClaudeTurnLifecycle(
  sink: StructuredAgentSessionEventSink,
  sessionId: string,
  turnId: string,
  running: boolean,
  turnTiming?: AgentJournalTurnTiming
): void {
  const identity = {
    provider: 'legacy' as const,
    agent: 'claude' as const,
    sessionId,
    recordId: `turn-lifecycle:${turnId}`
  }
  if (running) {
    sink.appendItem(
      identity,
      { kind: 'status', text: 'Claude is working…', turnLifecycle: { turnId, state: 'running' } },
      { lifecycle: true, turnTiming }
    )
  } else {
    sink.appendTombstone(identity, { lifecycle: true, turnTiming })
  }
  // Preserve first-work evidence when completion arrives before the journal drains.
  sink.publish({ coalescingKey: running ? `turn-start:${sessionId}:${turnId}` : 'publish' })
}
