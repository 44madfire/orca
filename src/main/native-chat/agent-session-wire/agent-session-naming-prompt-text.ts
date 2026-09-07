import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../../shared/native-chat-types'

/** Bounded so a pasted file cannot become the naming request's whole input. */
const MAX_NAMING_PROMPT_LENGTH = 2_000

/**
 * The user's own words from one submission, for a provider to title.
 *
 * Text only: an image carries nothing a one-line title can use, and sending its
 * path would leak a filesystem location into a generated label.
 */
export function agentSessionNamingPromptText(body: AgentJournalMessageItem): string | null {
  // `blocks` reaches here as provider/journal data, not something the type system
  // verified: only the RPC send path runs it through a schema. A non-array here
  // would throw on the send path and turn a delivered message into a failed one.
  if (!Array.isArray(body?.blocks)) {
    return null
  }
  const text = (body.blocks as NativeChatBlock[])
    .filter((block): block is Extract<NativeChatBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (!text) {
    return null
  }
  return text.length > MAX_NAMING_PROMPT_LENGTH ? text.slice(0, MAX_NAMING_PROMPT_LENGTH) : text
}
