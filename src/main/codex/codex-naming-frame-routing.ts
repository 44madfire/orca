import { isCodexNamingFrame, isCodexNamingThread } from './codex-conversation-name-generation'
import type { CodexAppServerServerRequest } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import { readCodexThreadId } from './codex-structured-thread-facts'

/**
 * Keeps a conversation-naming turn out of the user's chat.
 *
 * The naming turn runs on a throwaway thread over the session's own connection, and the journal
 * translator records items from ANY thread on it. Every frame a naming thread produces is routed
 * here instead, so its prompt and its JSON answer are never journalled.
 */

/** Diverts a naming-thread frame to the collector. True when the frame was consumed. */
export function routeCodexNamingFrame(
  session: CodexSession,
  method: string,
  params: unknown
): boolean {
  const frameThreadId = readCodexThreadId(params)
  if (!isCodexNamingFrame(session, frameThreadId)) {
    return false
  }
  // Diverted either way; only the exact-id half may settle the naming turn.
  session.naming?.handle(method, params, isCodexNamingThread(session, frameThreadId))
  return true
}

/**
 * Refuses a server request raised by the naming turn. True when the request was answered.
 *
 * Exact id only: the broad pre-id rule would refuse a SUB-AGENT's approval request during the
 * `thread/start` window, since the naming thread has no turn running yet and cannot be the one
 * asking.
 */
export function refuseCodexNamingServerRequest(
  session: CodexSession | undefined,
  request: CodexAppServerServerRequest
): boolean {
  if (!session || !isCodexNamingThread(session, readCodexThreadId(request.params))) {
    return false
  }
  // An approval request from the naming turn would become a durable prompt in the user's chat,
  // for a command they never asked for, left pending forever once the turn is abandoned. Refuse
  // it so the turn settles instead.
  session.connection.respondWithError(
    request.id,
    -32001,
    'Orca does not run tools on a conversation-naming turn'
  )
  return true
}
