import type { AgentSessionRecord } from '../../shared/agent-session-record'

/**
 * Records the provider's name for a conversation.
 *
 * Unfenced on purpose: a name is display metadata, not ownership, so a reader
 * that learned it must not have to win the lease to keep it. An unchanged name
 * is returned as-is, so a re-read costs no durable write.
 */
export function setAgentSessionRecordConversationName(
  record: AgentSessionRecord,
  conversationName: string,
  now: number
): AgentSessionRecord {
  return record.conversationName === conversationName
    ? record
    : { ...record, conversationName, updatedAt: now }
}
