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
  /** The durable naming state. Claude rebuilds its session object on every
   *  acquisition, so an in-memory flag alone would retitle the conversation —
   *  and pay for it — on the second message after every eviction. */
  readNamingState?: (sessionId: string) => {
    conversationName: string | null
    namingAttempted: boolean
  }
  markNamingAttempted?: (sessionId: string) => void
  onError?: (scope: string, error: unknown) => void
}

/**
 * Names the session once, off the turn's critical path.
 *
 * Asked at most once per CONVERSATION rather than once per session object, and
 * every step runs inside the promise: this sits on the send path, and nothing
 * here may turn a delivered message into a reported failure.
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
  session.namingAttempted = true
  void Promise.resolve()
    .then(async () => {
      const durable = deps.readNamingState?.(sessionId)
      if (durable?.conversationName || durable?.namingAttempted) {
        return
      }
      const description = agentSessionNamingPromptText(body)
      if (!description) {
        return
      }
      deps.markNamingAttempted?.(sessionId)
      const title = await session.connection.generateSessionTitle(description, {
        persist: true,
        ...(deps.requestTimeoutMs ? { timeoutMs: deps.requestTimeoutMs } : {})
      })
      if (title) {
        deps.onConversationName?.(sessionId, title)
      }
    })
    .catch((error: unknown) => deps.onError?.('claude-conversation-naming', error))
}
