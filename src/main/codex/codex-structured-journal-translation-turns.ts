import { codexStructuredTurnTiming } from './codex-structured-turn-timing'
import { readCodexTurnId } from './codex-structured-thread-facts'
import type { CodexJournalTranslatorDeps } from './codex-structured-journal-contracts'
import type { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'
import type { CodexStructuredSessionEvent } from './codex-structured-session-state'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

import type { AgentJournalTurnTiming } from '../../shared/agent-session-journal-types'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export function publishCodexTurnLifecycle(input: {
  sink: StructuredAgentSessionEventSink
  primaryThreadId: string | null
  sessionId: string
  threadId: string
  turnId: string
  state: 'running' | 'completed'
  turnTiming?: AgentJournalTurnTiming
}): StructuredAgentSessionSinkAdmission {
  if (input.primaryThreadId !== input.threadId) {
    return ADMITTED
  }
  const identity = {
    provider: 'legacy' as const,
    agent: 'codex' as const,
    sessionId: input.sessionId,
    recordId: `turn-lifecycle:${input.turnId}`
  }
  if (input.state === 'completed') {
    if (input.sink.tryAppendTombstone) {
      const admission = input.sink.tryAppendTombstone(identity, {
        lifecycle: true,
        turnTiming: input.turnTiming
      })
      if (!admission.accepted) {
        return admission
      }
    } else {
      input.sink.appendTombstone(identity, { lifecycle: true, turnTiming: input.turnTiming })
    }
  } else {
    const admission = input.sink.tryAppendItem
      ? input.sink.tryAppendItem(
          identity,
          {
            kind: 'status',
            text: 'Codex is working…',
            turnLifecycle: { turnId: input.turnId, state: input.state }
          },
          { lifecycle: true, turnTiming: input.turnTiming }
        )
      : (input.sink.appendItem(
          identity,
          {
            kind: 'status',
            text: 'Codex is working…',
            turnLifecycle: { turnId: input.turnId, state: input.state }
          },
          { lifecycle: true, turnTiming: input.turnTiming }
        ),
        ADMITTED)
    if (!admission.accepted) {
      return admission
    }
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

export function admitCodexJournalTurnStart(
  deps: CodexJournalTranslatorDeps,
  activeTurns: CodexJournalActiveTurns,
  event: Extract<CodexStructuredSessionEvent, { type: 'notification' }>,
  timingClock: string
): StructuredAgentSessionSinkAdmission {
  const turnId = readCodexTurnId(event.params)
  if (!turnId) {
    return ADMITTED
  }
  if (!activeTurns.canRemember(event.threadId, turnId)) {
    return { accepted: false, reason: 'backpressure' }
  }
  const admission = publishCodexTurnLifecycle({
    sink: deps.sink,
    primaryThreadId: deps.primaryThreadId?.() ?? null,
    sessionId: event.sessionId,
    threadId: event.threadId,
    turnId,
    state: 'running',
    turnTiming: codexStructuredTurnTiming(
      event.threadId,
      turnId,
      event.params,
      'start',
      event.observedAt,
      timingClock
    )
  })
  if (admission.accepted) {
    activeTurns.remember(event.threadId, turnId)
  }
  return admission
}
