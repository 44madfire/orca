// The conversation name Claude has already written into a session transcript,
// and how a live session hands it on.
//
// Claude's stream-json protocol carries no title frame, so the transcript is the
// only place a name it generated (or a name the user set from the CLI) survives.
// `custom-title` and `ai-title` are appended, last-wins records, so the file is
// read backwards in bounded chunks: a full parse on every acquisition competes
// with the attach it runs alongside, on files that reach many megabytes.
//
// Bounded means a title older than the tail limit is NOT found. That reads as
// "no name yet", never as "this conversation has no name" — and once any read
// succeeds the name is on the durable record, so the scan is not repeated.

import { normalizeTitleText, parseJsonObject } from '../ai-vault/session-scanner-values'
import { claudeTranscriptTailLines } from './claude-transcript-tail-scan'

/** What the transcript's tail says about this conversation's name. */
export type ClaudeTranscriptConversationName =
  | { kind: 'named'; title: string }
  /** The newest title record positively removes the name. */
  | { kind: 'cleared' }
  /** No title record in the tail. NOT evidence the conversation is unnamed: the
   *  scan is bounded, so an older record simply is not visible from here. */
  | { kind: 'unknown' }

/**
 * The transcript's stored name.
 *
 * A user's own `custom-title` outranks the generated `ai-title`, matching the
 * precedence the CLI itself applies. Read newest-first, so the first record of
 * each kind is the current one — and an emptied `custom-title` is the user
 * deleting the name, which must not read the same as never having had one.
 */
export async function readClaudeTranscriptConversationName(
  transcriptPath: string
): Promise<ClaudeTranscriptConversationName> {
  let generated: string | null = null
  for await (const line of claudeTranscriptTailLines(transcriptPath)) {
    if (!line.includes('-title')) {
      continue
    }
    const record = parseJsonObject(line)
    if (!record) {
      continue
    }
    if (record.type === 'custom-title') {
      const title = normalizeTitleText(String(record.customTitle ?? ''))
      return title ? { kind: 'named', title } : { kind: 'cleared' }
    }
    if (record.type === 'ai-title' && !generated) {
      generated = normalizeTitleText(String(record.aiTitle ?? '')) || null
    }
  }
  return generated ? { kind: 'named', title: generated } : { kind: 'unknown' }
}

export type ClaudeConversationNameReporter = {
  readTranscriptConversationName?: (input: {
    providerSessionId: string
    claudeConfigDir: string
  }) => Promise<ClaudeTranscriptConversationName>
  onConversationName?: (sessionId: string, conversationName: string) => void
  onConversationNameCleared?: (sessionId: string) => void
  onError?: (scope: string, error: unknown) => void
}

/**
 * Reports the name Claude persisted for a session that just went live.
 *
 * Deliberately not awaited: an unreadable or unnamed transcript must leave the
 * chat on its placeholder label rather than delay or fail the acquisition.
 */
export function reportPersistedClaudeConversationName(
  sessionId: string,
  session:
    | { providerSessionId: string; claudeConfigDir: string; namingAttempted?: boolean }
    | undefined,
  deps: ClaudeConversationNameReporter
): void {
  const read = deps.readTranscriptConversationName
  if (!session || !read || !deps.onConversationName) {
    return
  }
  void read({
    providerSessionId: session.providerSessionId,
    claudeConfigDir: session.claudeConfigDir
  })
    .then((found) => {
      if (found.kind === 'cleared') {
        // The user deleted the name in the CLI; a stale one here keeps rendering.
        deps.onConversationNameCleared?.(sessionId)
        return
      }
      if (found.kind !== 'named') {
        return
      }
      // A transcript that already holds a name is a conversation that is already
      // named; nothing should generate another one for it.
      session.namingAttempted = true
      deps.onConversationName?.(sessionId, found.title)
    })
    .catch((error: unknown) => deps.onError?.('claude-transcript-name', error))
}
