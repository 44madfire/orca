// The session-level half of naming a Codex conversation: when to ask, and where
// the answer goes. The generation flow itself lives beside this.

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import {
  createCodexNamingTurnCollector,
  generateAndSetCodexConversationName
} from './codex-conversation-name-generation'
import { agentSessionNamingPromptText } from '../native-chat/agent-session-wire/agent-session-naming-prompt-text'
import type { CodexSession } from './codex-structured-session-state'

/** A naming turn outlives no session: past this the chat keeps its placeholder. */
const NAMING_TURN_TIMEOUT_MS = 60_000

export type CodexConversationNamingInput = {
  sessionId: string
  session: CodexSession
  body: AgentJournalMessageItem
  requestTimeoutMs?: number
  onConversationName?: (sessionId: string, conversationName: string) => void
}

/**
 * Names the thread once per session, off the turn's critical path.
 *
 * One attempt only: a thread the model declined to name, or one a person
 * deliberately cleared, must not be re-asked on every later turn.
 */
export function startCodexConversationNaming(input: CodexConversationNamingInput): void {
  const { session, sessionId } = input
  if (session.namingAttempted || session.conversationName || !input.onConversationName) {
    return
  }
  const prompt = agentSessionNamingPromptText(input.body)
  if (!prompt) {
    return
  }
  session.namingAttempted = true
  void generateAndSetCodexConversationName({
    connection: session.connection,
    cwd: session.cwd,
    threadId: session.threadId,
    prompt,
    ...(input.requestTimeoutMs ? { timeoutMs: input.requestTimeoutMs } : {}),
    openNamingTurn: () => {
      const collector = createCodexNamingTurnCollector(NAMING_TURN_TIMEOUT_MS)
      session.naming = collector
      return collector
    },
    retainNamingThread: (namingThreadId) => session.namingThreadIds.add(namingThreadId),
    closeNamingTurn: () => {
      session.naming = null
    }
  })
    .then((name) => {
      // `thread/name/set` echoes back as `thread/name/updated`, but only while
      // this session still holds the connection; report directly so a name set
      // just before a close is not lost.
      if (name && session.conversationName !== name) {
        session.conversationName = name
        input.onConversationName?.(sessionId, name)
      }
    })
    // A thread with no name is the state this started in; never surface it.
    .catch(() => {
      session.naming = null
    })
}
