// The conversation name a provider gives one structured chat, normalized once
// so every surface that shows it agrees on the text.
//
// Providers publish this as free text a user can also edit from another client,
// so it is bounded and flattened here rather than at each display site: a name
// carrying a newline would break the tab strip and the sidebar row alike.

import { sliceAtCodeUnitLimit } from './surrogate-safe-text-slice'

/** Well past any provider's own cap, short enough that a pasted essay cannot become a tab label. */
export const AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH = 200

/** Whitespace, plus the C0/C1 controls and format characters `\s` misses. A
 *  bidi override renders a label that reads as text the name does not contain,
 *  and a zero-width run renders as nothing at all. */
const UNRENDERABLE_RUN = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu

export function normalizeAgentSessionConversationName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const collapsed = value.replace(UNRENDERABLE_RUN, ' ').trim()
  if (!collapsed) {
    return null
  }
  // Cut on a character boundary: a raw slice can strand a lone high surrogate,
  // which every surface then renders as U+FFFD.
  return collapsed.length > AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH
    ? sliceAtCodeUnitLimit(collapsed, AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH).trimEnd()
    : collapsed
}

export function isAgentSessionConversationName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH
  )
}
