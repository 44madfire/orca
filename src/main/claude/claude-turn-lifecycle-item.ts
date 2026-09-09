import type {
  AgentJournalItemIdentity,
  AgentJournalStatusItem
} from '../../shared/agent-session-journal-types'
import { agentTurnLifecycleText } from '../../shared/agent-turn-lifecycle-text'
import type { StructuredAgentSessionAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { claudeText } from './claude-structured-item-translation'

export type ClaudeCurrentTurn = { sessionId: string; turnId: string; startedAt: number }

export type ClaudeTurnEnd = { state: 'completed' | 'interrupted'; completedAt: number }

/** A result the SDK reports as aborted is the user's stop, not the model's end. */
export function claudeTurnEndForResult(
  message: Record<string, unknown>,
  completedAt: number
): ClaudeTurnEnd {
  const reason = message.is_error === true ? claudeText(message.terminal_reason) : null
  return {
    state:
      reason === 'aborted_streaming' || reason === 'aborted_tools' ? 'interrupted' : 'completed',
    completedAt
  }
}

export function claudeTurnLifecycleIdentity(
  sessionId: string,
  turnId: string
): AgentJournalItemIdentity {
  return {
    provider: 'legacy',
    agent: 'claude',
    sessionId,
    recordId: `turn-lifecycle:${turnId}`
  }
}

/** The lifecycle row is revised to its terminal state, never tombstoned, so the
 *  turn's host-clock endpoints outlive the turn. */
export function claudeTurnLifecycleItem(
  turn: ClaudeCurrentTurn,
  end?: ClaudeTurnEnd
): {
  identity: AgentJournalItemIdentity
  body: AgentJournalStatusItem
  options: StructuredAgentSessionAppendOptions
  publishCoalescingKey: string
} {
  const { sessionId, turnId, startedAt } = turn
  return {
    identity: claudeTurnLifecycleIdentity(sessionId, turnId),
    body: {
      kind: 'status',
      text: agentTurnLifecycleText('Claude', end ? end.state : 'running'),
      turnLifecycle: end
        ? { turnId, state: end.state, startedAt, completedAt: end.completedAt }
        : { turnId, state: 'running', startedAt }
    },
    // The running row's ts is the turn start itself, so clients read no append lag.
    options: end ? {} : { observedAt: startedAt },
    publishCoalescingKey: end ? 'publish' : `turn-start:${sessionId}:${turnId}`
  }
}
