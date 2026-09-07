// The conversation name Claude has already written into a session transcript,
// and how a live session hands it on.
//
// Claude's stream-json protocol carries no title frame, so the transcript is the
// only place a name it generated (or a name the user set from the CLI) survives.
// The records are read through the AI Vault session parser rather than a second
// one, so `custom-title` / `ai-title` keep meaning exactly what they mean there.

import { createInterface } from 'node:readline'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import {
  consumeClaudeSessionLine,
  createClaudeSessionParseState
} from '../ai-vault/session-scanner-primary-parsers'

/**
 * The transcript's stored name, or null when it holds none.
 *
 * A user's own `custom-title` outranks the generated `ai-title`, matching the
 * precedence the CLI itself applies when it shows the session's name.
 */
export async function readClaudeTranscriptConversationName(
  transcriptPath: string
): Promise<string | null> {
  const state = createClaudeSessionParseState({
    path: transcriptPath,
    mtimeMs: 0,
    modifiedAt: new Date(0).toISOString()
  })
  const stream = openTranscriptReadStream(transcriptPath, { encoding: 'utf-8' }, 'scan')
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      consumeClaudeSessionLine(state, line)
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return state.accumulator.title || state.generatedTitle || null
}

export type ClaudeConversationNameReporter = {
  readTranscriptConversationName?: (input: {
    providerSessionId: string
    claudeConfigDir: string
  }) => Promise<string | null>
  onConversationName?: (sessionId: string, conversationName: string) => void
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
    .then((name) => {
      if (!name) {
        return
      }
      // A transcript that already holds a name is a conversation that is already
      // named; nothing should generate another one for it.
      if (session) {
        session.namingAttempted = true
      }
      deps.onConversationName?.(sessionId, name)
    })
    .catch(() => undefined)
}
