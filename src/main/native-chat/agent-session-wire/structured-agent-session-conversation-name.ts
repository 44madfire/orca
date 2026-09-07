// Where a provider's name for a conversation becomes the structured chat's label.
//
// Providers PUSH: Codex reports the thread's name when it opens one and again on
// every rename, and Claude's name is read out of its transcript once a session
// is live. Nothing polls, so the name has one path in and one way out — the
// durable record — and only a name that actually CHANGED notifies. A re-read on
// every attach must not re-publish an unchanged label.
//
// Nothing here may fail an attach or a turn: the name is display metadata, so a
// store write that loses a race with a close is dropped rather than retried.

import { normalizeAgentSessionConversationName } from '../../../shared/agent-session-conversation-name'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

export type StructuredAgentSessionConversationNameDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'setConversationName'>
  now: () => number
  onChanged: (sessionId: string, conversationName: string) => void
}

export class StructuredAgentSessionConversationNames {
  constructor(private readonly deps: StructuredAgentSessionConversationNameDeps) {}

  /** Records a name a provider published. Ignores anything that is not a usable name. */
  publish = async (sessionId: string, reported: unknown): Promise<void> => {
    const conversationName = normalizeAgentSessionConversationName(reported)
    if (!conversationName) {
      return
    }
    // Read first so an unchanged name costs no durable transaction and no fan-out.
    if (this.deps.store.getRecord(sessionId)?.conversationName === conversationName) {
      return
    }
    try {
      await this.deps.store.setConversationName(sessionId, conversationName, this.deps.now())
    } catch {
      // The record is gone or reconciling. A label is never worth surfacing a failure for.
      return
    }
    this.deps.onChanged(sessionId, conversationName)
  }
}
