import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  bindOutboxSettlement,
  retainOutboxSettlement,
  settleOutboxObservation
} from './structured-agent-session-outbox-settlement'
import { transitionOutbox } from './structured-agent-session-outbox-transitions'

export function enqueueStructuredAgentSessionLaunchPrompt(
  sessionId: string,
  text: string
): StructuredAgentSessionOutboxEntry | null {
  const entry = createStructuredAgentSessionOutboxEntry({
    clientMessageId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
    sessionId,
    text,
    attachments: [],
    queuedAt: Date.now()
  })
  retainOutboxSettlement(entry)
  const result = transitionOutbox(sessionId, (entries) => [...entries, entry])
  if (!result.ok) {
    settleOutboxObservation(entry, 'unavailable')
    return null
  }
  const staged = result.entries.find(
    (candidate) => candidate.clientMessageId === entry.clientMessageId
  )!
  bindOutboxSettlement(entry, staged)
  return staged
}

export function discardStructuredAgentSessionLaunchOutbox(sessionId: string): void {
  transitionOutbox(sessionId, () => [])
}
