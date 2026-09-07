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
// "no name yet", never as "this conversation has no name".
//
// This runs on EVERY acquisition, deliberately: it is how a rename made in the
// CLI reaches Orca at all, so gating it on "already named" would freeze the
// first name forever. It both fills and clears, and clearing an already-cleared
// record is a no-op, so the repeat costs a bounded read and nothing else.

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
 * precedence the CLI itself applies — including when the custom slot is EMPTY,
 * which falls back to the generated name rather than reading as no name at all.
 * Only an emptied custom slot with nothing to fall back to is a clear.
 *
 * Read newest-first, so the first record of each type is the current one.
 *
 * Fails closed on a shape it cannot read: a `custom-title` whose field is absent,
 * null, or renamed by a future CLI is skipped, never taken as a deliberate clear.
 * Wrongly clearing destroys a name the user can still see in their CLI.
 */
export async function readClaudeTranscriptConversationName(
  transcriptPath: string
): Promise<ClaudeTranscriptConversationName> {
  let generated: string | null = null
  let customCleared = false
  for await (const line of claudeTranscriptTailLines(transcriptPath)) {
    if (!line.includes('-title')) {
      continue
    }
    const record = parseJsonObject(line)
    if (!record) {
      continue
    }
    if (record.type === 'custom-title' && !customCleared) {
      if (typeof record.customTitle !== 'string') {
        continue
      }
      const title = normalizeTitleText(record.customTitle)
      if (title) {
        return { kind: 'named', title }
      }
      customCleared = true
      continue
    }
    if (record.type === 'ai-title' && !generated) {
      generated = normalizeTitleText(String(record.aiTitle ?? '')) || null
    }
  }
  if (generated) {
    return { kind: 'named', title: generated }
  }
  return customCleared ? { kind: 'cleared' } : { kind: 'unknown' }
}

/** The adapter's own dep bag, which names this reporter's error hook differently.
 *  Mapped rather than passed by reference: an undeclared key survives only while
 *  the object happens to be handed over whole, and typecheck cannot see it go. */
export type ClaudeConversationNameReporterSource = ClaudeConversationNameReporter & {
  onNamingError?: (scope: string, error: unknown) => void
}

export function claudeConversationNameReporterDeps(
  source: ClaudeConversationNameReporterSource
): ClaudeConversationNameReporter {
  return {
    ...(source.readTranscriptConversationName
      ? { readTranscriptConversationName: source.readTranscriptConversationName }
      : {}),
    ...(source.onConversationName ? { onConversationName: source.onConversationName } : {}),
    ...(source.onConversationNameCleared
      ? { onConversationNameCleared: source.onConversationNameCleared }
      : {}),
    ...((source.onError ?? source.onNamingError)
      ? { onError: (source.onError ?? source.onNamingError)! }
      : {})
  }
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
  source: ClaudeConversationNameReporterSource
): void {
  const deps = claudeConversationNameReporterDeps(source)
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
        // Marked attempted for the same reason the durable clear is: their next
        // message must not quietly generate a replacement.
        session.namingAttempted = true
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
