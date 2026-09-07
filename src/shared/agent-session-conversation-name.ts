// The conversation name a provider gives one structured chat, normalized once
// so every surface that shows it agrees on the text.
//
// Providers publish this as free text a user can also edit from another client,
// so it is bounded and flattened here rather than at each display site: a name
// carrying a newline would break the tab strip and the sidebar row alike.

import { sliceAtCodeUnitLimit } from './surrogate-safe-text-slice'

/** Well past any provider's own cap, short enough that a pasted essay cannot become a tab label. */
export const AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH = 200

/** Whitespace, plus the C0/C1 controls, bidi controls and zero-width marks `\s`
 *  misses. A bidi override renders a label that reads as text the name does not
 *  contain, and a zero-width run renders as nothing at all. Named rather than
 *  taken as all of `\p{Cf}`, which would also strip U+200C/U+200D — joiners that
 *  are load-bearing in Persian, Hindi and every multi-part emoji. */
const UNRENDERABLE_RUN =
  /[\s\p{Cc}\p{Zl}\p{Zp}\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]+/gu

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
