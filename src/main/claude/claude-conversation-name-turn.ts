// Naming a Claude conversation.
//
// Claude's stream-json protocol carries no title frame, and the CLI's own
// auto-titling lives in its interactive UI: a session driven over stream-json is
// never titled on its own. The Agent SDK exposes the request directly, so Orca
// asks once, and `persist` makes the CLI write the answer into its transcript as
// the `ai-title` record a later attach reads back.
//
// Deliberately NOT Codex's imperative-verb style: Claude's own titling is a short
// noun phrase in sentence case, and the SDK call already produces that. Passing
// the user's text as the description and nothing else keeps it that way.

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { agentSessionNamingPromptText } from '../native-chat/agent-session-wire/agent-session-naming-prompt-text'
import type { ClaudeSession } from './claude-structured-session-state'

export type ClaudeConversationNamingDeps = {
  requestTimeoutMs?: number
  onConversationName?: (sessionId: string, conversationName: string) => void
}

/**
 * Names the session once, off the turn's critical path.
 *
 * One attempt only: a CLI that exposes no title request, or a turn the model
 * declined to name, must not be re-asked on every later turn.
 */
export function startClaudeConversationNaming(
  sessionId: string,
  session: ClaudeSession,
  body: AgentJournalMessageItem,
  deps: ClaudeConversationNamingDeps
): void {
  if (session.namingAttempted || !deps.onConversationName) {
    return
  }
  const description = agentSessionNamingPromptText(body)
  if (!description) {
    return
  }
  session.namingAttempted = true
  // Started inside a promise so NOTHING here can reach the caller. This runs on
  // the send path, and an integration fake without the method turned a delivered
  // message into a reported failure — a synchronous throw from any cause would do
  // the same. A chat with no name beats a send that claims it failed.
  void Promise.resolve()
    .then(() =>
      session.connection.generateSessionTitle(description, {
        persist: true,
        ...(deps.requestTimeoutMs ? { timeoutMs: deps.requestTimeoutMs } : {})
      })
    )
    .then((title) => {
      if (title) {
        deps.onConversationName?.(sessionId, title)
      }
    })
    // A session without a name is the state this started in; never surface it.
    .catch(() => undefined)
}
