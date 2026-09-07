// The session-level half of naming a Codex conversation: when to ask, and where
// the answer goes. The generation flow itself lives beside this.

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { agentSessionNamingPromptText } from '../native-chat/agent-session-wire/agent-session-naming-prompt-text'
import {
  createCodexNamingTurnCollector,
  generateAndSetCodexConversationName
} from './codex-conversation-name-generation'
import { readCodexThreadId, readCodexThreadName } from './codex-structured-thread-facts'
import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'

/** A naming turn outlives no session: past this the chat keeps its placeholder. */
const NAMING_TURN_TIMEOUT_MS = 60_000

export type CodexConversationNamingInput = {
  sessionId: string
  session: CodexSession
  body: AgentJournalMessageItem
  requestTimeoutMs?: number
  onConversationName?: (sessionId: string, conversationName: string) => void
  /** Durable "we already asked", so an eviction or restart does not re-ask. */
  readNamingAttempted?: (sessionId: string) => boolean
  markNamingAttempted?: (sessionId: string) => void
  onError?: (scope: string, error: unknown) => void
}

/**
 * Names the thread once, off the turn's critical path.
 *
 * Asked at most once per CONVERSATION, not once per session object: the durable
 * marker means a thread the model declined to name, and a name a person
 * deliberately cleared, are not re-asked after an eviction or a restart.
 *
 * Everything runs inside the promise, including reading the user's text: this
 * sits on the send path, and nothing here may turn a delivered message into a
 * reported failure.
 */
export function startCodexConversationNaming(input: CodexConversationNamingInput): void {
  const { session, sessionId } = input
  if (session.namingAttempted || session.conversationName || !input.onConversationName) {
    return
  }
  session.namingAttempted = true
  void Promise.resolve()
    .then(async () => {
      if (input.readNamingAttempted?.(sessionId)) {
        return
      }
      const prompt = agentSessionNamingPromptText(input.body)
      if (!prompt) {
        return
      }
      const outcome = await generateAndSetCodexConversationName({
        connection: session.connection,
        cwd: session.cwd,
        threadId: session.threadId,
        prompt,
        ...(input.requestTimeoutMs ? { timeoutMs: input.requestTimeoutMs } : {}),
        ...(input.onError ? { onError: input.onError } : {}),
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
      // Marked only on a SETTLED answer, and only after the fact: a host that
      // could not be asked must stay askable, or upgrading the app-server would
      // never rescue the conversations it failed on.
      if (outcome.settled) {
        input.markNamingAttempted?.(sessionId)
      }
      // `thread/name/set` echoes back as `thread/name/updated`, but only while
      // this session still holds the connection; report directly so a name set
      // just before a close is not lost.
      if (outcome.name && session.conversationName !== outcome.name) {
        session.conversationName = outcome.name
        input.onConversationName?.(sessionId, outcome.name)
      }
    })
    .catch((error: unknown) => {
      session.naming = null
      input.onError?.('codex-conversation-naming', error)
    })
}

/**
 * Records a name Codex reported for THIS session's thread, or the clearing of it.
 *
 * Codex broadcasts `thread/name/updated` for every thread it has stored, so a
 * frame naming another thread must not relabel this chat. A frame for this thread
 * carrying no name is a deletion: leaving the old one would keep rendering a name
 * the user removed.
 */
export function captureCodexConversationName(
  sessionId: string,
  session: CodexSession,
  method: string,
  params: unknown,
  deps: Pick<CodexStructuredSessionAdapterDeps, 'onConversationName' | 'onConversationNameCleared'>
): void {
  if (method !== 'thread/name/updated') {
    return
  }
  if ((readCodexThreadId(params) ?? session.threadId) !== session.threadId) {
    return
  }
  const conversationName = readCodexThreadName(params)
  if (!conversationName) {
    if (session.conversationName !== null) {
      session.conversationName = null
      deps.onConversationNameCleared?.(sessionId)
    }
    return
  }
  if (conversationName === session.conversationName) {
    return
  }
  session.conversationName = conversationName
  deps.onConversationName?.(sessionId, conversationName)
}
