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
// emitting for it by then. Once the id IS known it is retained for the life of
// the session, because a turn that timed out is never cancelled and can still be
// emitting long after this flow gave up on it — tying the route's lifetime to the
// flow's would reopen the leak on exactly that path.
//
// The thread is RE-READ immediately before the name is set, because generation
// takes seconds and another client may have named the thread in the meantime; a
// name a person chose must never lose to one Orca inferred.

import type { CodexAppServerConnection } from './codex-app-server-connection'
import { readCodexThreadId, readCodexThreadName } from './codex-structured-thread-facts'

/** Short enough to read as a tab label at a glance; also the schema's own cap. */
export const CODEX_CONVERSATION_NAME_MAX_LENGTH = 36

export const CODEX_CONVERSATION_NAME_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: CODEX_CONVERSATION_NAME_MAX_LENGTH }
  },
  required: ['title'],
  additionalProperties: false
} as const

/**
 * Reasoning effort for the naming turn. A title is not a reasoning problem, and
 * the user is spending their own account on it.
 *
 * The turn deliberately names NO MODEL, so it runs on the session's own. The
 * model catalog carries no structured "small and fast" signal — `modelSpecialty`
 * is null across every entry — so choosing one would mean matching marketing
 * prose or vendor id shapes like `-mini`, neither of which survives a different
 * provider, and naming a model the account cannot use fails the turn outright.
 * The cost is bounded instead: lowest effort, prompt capped, and a schema that
 * caps the answer at 36 characters. Once per conversation, off the send path.
 */
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

/** The naming state one session carries: the collector while a turn is in
 *  flight, and every throwaway thread this session has ever opened. */
export type CodexNamingState = {
  naming: CodexNamingTurnCollector | null
  namingThreadIds: Set<string>
  threadId: string
}

/**
 * Whether a frame belongs to a naming turn rather than the user's conversation.
 *
 * Normally an exact match against a thread this session opened for naming, held
 * for the session's life. The broad "any other thread" rule applies ONLY in the
 * window before `thread/start` has returned that id — while no naming thread is
 * known yet — because a Codex SUB-AGENT runs on its own thread over this same
 * connection. Treating those as naming frames would drop the sub-agent's rows
 * from the transcript, feed its reply to the collector as the naming answer, and
 * auto-refuse an approval the user's own agent asked for.
 *
 * A frame naming no thread cannot be attributed and passes through, as it always
 * has.
 */
export function isCodexNamingFrame(state: CodexNamingState, frameThreadId: string | null): boolean {
  if (frameThreadId === null || frameThreadId === state.threadId) {
    return false
  }
  if (state.namingThreadIds.has(frameThreadId)) {
    return true
  }
  return state.naming !== null && state.namingThreadIds.size === 0
}

/** Collects one ephemeral naming turn's frames and reports its answer. */
export type CodexNamingTurnCollector = {
  handle: (method: string, params: unknown) => void
  /** The turn's final agent message, or null when it produced none. */
  answer: Promise<string | null>
}

/**
 * Whether an `error` frame ends the turn. There is no `turn/failed`; a refused or
 * rate-limited turn arrives as `error`. A RETRYABLE one explicitly does not
 * interrupt the turn, so settling on it would abandon a naming turn that was
 * about to succeed.
 */
export function isTerminalCodexTurnError(method: string, params: unknown): boolean {
  if (method !== 'error') {
    return false
  }
  if (typeof params !== 'object' || params === null) {
    return false
  }
  return (
    (params as { willRetry?: unknown; will_retry?: unknown }).willRetry !== true &&
    (params as { will_retry?: unknown }).will_retry !== true
  )
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
      } else if (method === 'turn/completed' || isTerminalCodexTurnError(method, params)) {
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

/**
 * True only when the reply is one this build understands AND carries no name.
 * An unrecognised shape is not evidence of an unnamed thread.
 */
export function isCodexThreadReadablyUnnamed(read: unknown): boolean {
  if (typeof read !== 'object' || read === null) {
    return false
  }
  const thread = (read as { thread?: unknown }).thread
  if (typeof thread !== 'object' || thread === null) {
    return false
  }
  // A thread reply this build can read always names the thread it describes.
  if (typeof (thread as { id?: unknown }).id !== 'string') {
    return false
  }
  return readCodexThreadName(read) === null
}

/** Whether the app-server confirmed the thread it opened is throwaway. */
export function readCodexThreadIsEphemeral(opened: unknown): boolean {
  if (typeof opened !== 'object' || opened === null) {
    return false
  }
  const thread = (opened as { thread?: unknown }).thread
  return (
    typeof thread === 'object' &&
    thread !== null &&
    (thread as { ephemeral?: unknown }).ephemeral === true
  )
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
  /** Retains the throwaway thread for the life of the session, so frames still
   *  arriving after this flow gives up are dropped rather than journaled. */
  retainNamingThread: (namingThreadId: string) => void
  closeNamingTurn: () => void
  /** Diagnostics only; naming never surfaces to the user. */
  onError?: (scope: string, error: unknown) => void
}

/**
 * What one naming attempt concluded.
 *
 * `settled` separates "we asked and got an answer" from "this host could not
 * ask": only the former may durably mark the conversation as attempted. Marking
 * a host failure would forfeit naming forever — including after the user
 * upgrades the CLI or app-server that could not do it.
 */
export type CodexConversationNameOutcome = {
  name: string | null
  settled: boolean
}

/**
 * Generates a name for one thread and sets it, unless the thread acquired a name
 * while this was running.
 */
export async function generateAndSetCodexConversationName(
  input: CodexConversationNameGeneration
): Promise<CodexConversationNameOutcome> {
  const { connection, timeoutMs } = input
  const collector = input.openNamingTurn()
  let answer: string | null
  let disposableThreadId: string | null = null
  try {
    const opened = await connection.request(
      'thread/start',
      { cwd: input.cwd, ephemeral: true },
      { timeoutMs }
    )
    const namingThreadId = readCodexThreadId(opened)
    // No usable throwaway thread is a host that could not be asked, not a decline.
    // An app-server that ignored `ephemeral` hands back a NEW PERSISTED thread,
    // not the user's — so the id check below is not what protects them; the
    // delete in the finally block is. The check covers only a reply that names
    // the session's own thread, which would put this turn straight into the
    // user's chat. A reply naming some OTHER pre-existing thread of the user's
    // is not guarded and is not treated as a real risk: `thread/start` returns
    // the thread it just opened.
    if (!namingThreadId || namingThreadId === input.threadId) {
      return { name: null, settled: false }
    }
    input.retainNamingThread(namingThreadId)
    // Only when `ephemeral` was NOT honoured. A truly ephemeral thread refuses
    // deletion ("thread is not persisted and cannot be deleted"), so attempting
    // it unconditionally would log a failure on every successful naming.
    if (!readCodexThreadIsEphemeral(opened)) {
      disposableThreadId = namingThreadId
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
    // Set only when the app-server persisted the thread despite `ephemeral`.
    // Without this, every named chat would leave a junk thread and rollout file
    // in the user's Codex history that Orca never shows and never reclaims.
    if (disposableThreadId) {
      await connection
        .request('thread/delete', { threadId: disposableThreadId }, { timeoutMs })
        .catch((error: unknown) => input.onError?.('delete-naming-thread', error))
    }
  }
  // A turn that ended with no usable title is a decline and settles; one that
  // never answered at all (the collector's timeout) did not.
  if (answer === null) {
    return { name: null, settled: false }
  }
  const title = readCodexGeneratedTitle(answer)
  if (!title) {
    return { name: null, settled: true }
  }
  // Re-read LAST: generation takes seconds, and a name a person chose in that
  // window outranks this one. Losing the race means doing nothing, not retrying.
  const current = await connection.request(
    'thread/read',
    { threadId: input.threadId },
    { timeoutMs }
  )
  // Asymmetry worth knowing: a user who NAMES the thread during the window wins
  // here, but one who CLEARS a name during it loses — the re-read sees it unnamed
  // and this sets. Narrow: first turn only, and the durable attempted marker means
  // it cannot recur for that conversation.
  //
  // Fails CLOSED. Only a reply this build can positively read as unnamed permits
  // the write: a shape it does not recognise would otherwise read as "unnamed"
  // and clobber a name a person chose. Skipping a name is a non-event.
  if (!isCodexThreadReadablyUnnamed(current)) {
    return { name: null, settled: true }
  }
  await connection.request(
    'thread/name/set',
    { threadId: input.threadId, name: title },
    { timeoutMs }
  )
  return { name: title, settled: true }
}
