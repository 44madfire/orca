import type {
  AgentJournalItemIdentity,
  AgentJournalStatusItem,
  AgentJournalTurnLifecycle,
  AgentJournalTurnLifecycleState
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export function codexTurnLifecycleIdentity(
  sessionId: string,
  turnId: string
): AgentJournalItemIdentity {
  return {
    provider: 'legacy',
    agent: 'codex',
    sessionId,
    recordId: `turn-lifecycle:${turnId}`
  }
}

export function codexTurnLifecycleBody(
  turnLifecycle: AgentJournalTurnLifecycle
): AgentJournalStatusItem {
  const text = turnLifecycle.state === 'running' ? 'Codex is working…' : 'Codex turn completed'
  return { kind: 'status', text, turnLifecycle }
}

/** `turn/completed` is Codex's only turn-end notification; a missing status is a clean finish. */
export function codexTurnLifecycleState(
  status: string | null
): Extract<AgentJournalTurnLifecycleState, 'completed' | 'interrupted'> {
  return status === null || status === 'completed' ? 'completed' : 'interrupted'
}

export function publishCodexTurnLifecycle(input: {
  sink: StructuredAgentSessionEventSink
  primaryThreadId: string | null
  sessionId: string
  threadId: string
  turnId: string
  state: AgentJournalTurnLifecycleState
  startedAt?: number
  completedAt?: number
}): StructuredAgentSessionSinkAdmission {
  if (input.primaryThreadId !== input.threadId) {
    return ADMITTED
  }
  const identity = codexTurnLifecycleIdentity(input.sessionId, input.turnId)
  const body = codexTurnLifecycleBody({
    turnId: input.turnId,
    state: input.state,
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {})
  })
  // The running row's `ts` is the host's turn-start receipt so clients can anchor a live counter.
  const appendOptions = {
    lifecycle: true,
    ...(input.state === 'running' && input.startedAt !== undefined
      ? { observedAt: input.startedAt }
      : {})
  }
  if (input.sink.tryAppendItem) {
    const admission = input.sink.tryAppendItem(identity, body, appendOptions)
    if (!admission.accepted) {
      return admission
    }
  } else {
    input.sink.appendItem(identity, body, appendOptions)
  }
  // Preserve first-work evidence when completion arrives before the journal drains.
  const publishOptions = {
    lifecycle: true,
    ...(input.state === 'running'
      ? { coalescingKey: `turn-start:${input.sessionId}:${input.turnId}` }
      : {})
  }
  if (input.sink.tryPublish) {
    return input.sink.tryPublish(publishOptions)
  }
  input.sink.publish(publishOptions)
  return ADMITTED
}
