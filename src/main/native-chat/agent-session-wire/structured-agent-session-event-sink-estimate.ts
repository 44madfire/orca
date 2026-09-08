import type {
  AgentJournalItemBody,
  AgentJournalTurnTiming,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'

export function estimateStructuredAgentSessionItemBytes(
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  turnTiming?: AgentJournalTurnTiming
): number {
  return Buffer.byteLength(JSON.stringify({ identity, body, turnTiming }), 'utf8') + 512
}
