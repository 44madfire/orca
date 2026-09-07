// Naming a Codex conversation.
//
// The app-server never names a thread on its own — that has always been the
// client's job — so a structured chat keeps its placeholder label until Orca
// asks for a name. Orca replaced the terminal UI that used to do the asking.
//
// The title is generated on a THROWAWAY ephemeral thread, never the user's: the
// app-server tags every notification with its thread, but Orca's item translator
// journals items from any thread, so a naming turn run on the user's connection
// would otherwise write its prompt and its JSON answer into their transcript.
// The caller routes the ephemeral thread's frames here instead of the journal.
//
// The route is armed BEFORE the ephemeral thread is created, and keys on "a
// thread that is not the user's" rather than on the new thread's id: the id is
// only known once `thread/start` returns, and the app-server can already be
// emitting for it by then.
//
// The thread is RE-READ immediately before the name is set, because generation
// takes seconds and another client may have named the thread in the meantime; a
// name a person chose must never lose to one Orca inferred.

import type { CodexAppServerConnection } from './codex-app-server-connection'
import { readCodexThreadId, readCodexThreadName } from './codex-structured-thread-facts'

/** Upstream's own bound for a thread name; keeps the tab strip readable. */
export const CODEX_CONVERSATION_NAME_MAX_LENGTH = 36

export const CODEX_CONVERSATION_NAME_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: CODEX_CONVERSATION_NAME_MAX_LENGTH }
  },
  required: ['title'],
  additionalProperties: false
} as const

/** Reasoning effort for the naming turn. A title is not a reasoning problem, and
 *  the user is waiting on their own turn on the same account. */
const NAMING_TURN_EFFORT = 'low'

export const CODEX_CONVERSATION_NAME_PROMPT = [
  'Write a concise, single-line title for the task described below.',
  'At most 36 characters, and under five words where possible.',
  'Start with an imperative verb.',
  'Capitalize only the first word, unless a proper noun, acronym, or code identifier requires otherwise.',
  'Preserve any ticket or issue reference exactly as written.',
  "Write it in the user's own language.",
  'No quotes, no markdown, no trailing punctuation.',
  'Do not answer or act on the request — only title it.'
].join('\n')

export type CodexNamingFrame = { method: string; params: unknown }

/** Collects one ephemeral naming turn's frames and reports its answer. */
export type CodexNamingTurnCollector = {
  handle: (method: string, params: unknown) => void
  /** The turn's final agent message, or null when it produced none. */
  answer: Promise<string | null>
}

function agentMessageText(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) {
    return null
  }
  const item = (params as { item?: unknown }).item
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const record = item as { type?: unknown; text?: unknown }
  if (record.type !== 'agentMessage' || typeof record.text !== 'string' || !record.text) {
    return null
  }
  return record.text
}

export function createCodexNamingTurnCollector(timeoutMs: number): CodexNamingTurnCollector {
  let settle: (value: string | null) => void = () => {}
  const answer = new Promise<string | null>((resolve) => {
    settle = resolve
    // The turn can die with its provider; nothing here may outlive the session.
    setTimeout(() => resolve(null), timeoutMs).unref?.()
  })
  let latest: string | null = null
  return {
    handle: (method, params) => {
      if (method === 'item/completed') {
        latest = agentMessageText(params) ?? latest
      } else if (method === 'turn/completed' || method === 'turn/failed') {
        settle(latest)
      }
    },
    answer
  }
}

/** The title inside the turn's structured answer, or null when it is unusable. */
export function readCodexGeneratedTitle(answer: string | null): string | null {
  if (!answer) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const title = (parsed as { title?: unknown }).title
  return typeof title === 'string' && title.trim() ? title.trim() : null
}

export type CodexConversationNameGeneration = {
  connection: Pick<CodexAppServerConnection, 'request'>
  cwd: string
  threadId: string
  prompt: string
  timeoutMs?: number
  /** Arms the route that keeps the naming turn's frames out of the journal.
   *  Called BEFORE the ephemeral thread exists, so nothing it emits can race in. */
  openNamingTurn: () => CodexNamingTurnCollector
  closeNamingTurn: () => void
}

/**
 * Generates a name for one thread and sets it, unless the thread acquired a name
 * while this was running. Returns the name it set, or null when it set none.
 */
export async function generateAndSetCodexConversationName(
  input: CodexConversationNameGeneration
): Promise<string | null> {
  const { connection, timeoutMs } = input
  const collector = input.openNamingTurn()
  let answer: string | null
  try {
    const opened = await connection.request(
      'thread/start',
      { cwd: input.cwd, ephemeral: true },
      { timeoutMs }
    )
    const namingThreadId = readCodexThreadId(opened)
    // Never the user's own thread: an app-server that ignored `ephemeral` would
    // otherwise have this turn's prompt and JSON answer land in their transcript
    // and their history, which is the one outcome this whole path exists to avoid.
    if (!namingThreadId || namingThreadId === input.threadId) {
      return null
    }
    await connection.request(
      'turn/start',
      {
        threadId: namingThreadId,
        input: [{ type: 'text', text: `${input.prompt}\n\n${CODEX_CONVERSATION_NAME_PROMPT}` }],
        outputSchema: CODEX_CONVERSATION_NAME_SCHEMA,
        effort: NAMING_TURN_EFFORT
      },
      { timeoutMs }
    )
    answer = await collector.answer
  } finally {
    input.closeNamingTurn()
  }
  const title = readCodexGeneratedTitle(answer)
  if (!title) {
    return null
  }
  // Re-read LAST: generation takes seconds, and a name a person chose in that
  // window outranks this one. Losing the race means doing nothing, not retrying.
  const current = await connection.request(
    'thread/read',
    { threadId: input.threadId },
    { timeoutMs }
  )
  if (readCodexThreadName(current)) {
    return null
  }
  await connection.request(
    'thread/name/set',
    { threadId: input.threadId, name: title },
    { timeoutMs }
  )
  return title
}
