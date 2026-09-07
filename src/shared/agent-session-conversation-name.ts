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
 *  contain, and a zero-width run renders as nothing at all. Subtracted from all
 *  of `\p{Cf}` rather than enumerated, so a format character Unicode adds later
 *  is covered with no list to remember; U+200C/U+200D are the one exception,
 *  being load-bearing in Persian, Hindi and every multi-part emoji. Accepted
 *  cost: the U+E0020-E007F tag sequences go too, so the England, Scotland and
 *  Wales flags degrade — far cheaper than an invisible payload in a label. */
const UNRENDERABLE_RUN = /(?:[\s\p{Cc}\p{Zl}\p{Zp}]|(?![\u200C\u200D])\p{Cf})+/gu

/** The joiners outlive the run above by design; alone they are still a blank label. */
const JOINERS_ONLY = /^[\u200C\u200D]+$/u

/** A cut inside an emoji sequence strands the joiner that attached it. */
const TRAILING_DANGLE = /[\s\u200C\u200D]+$/u

export function normalizeAgentSessionConversationName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const collapsed = value.replace(UNRENDERABLE_RUN, ' ').trim()
  if (!collapsed || JOINERS_ONLY.test(collapsed)) {
    return null
  }
  if (collapsed.length <= AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH) {
    return collapsed
  }
  // Cut on a character boundary: a raw slice can strand a lone high surrogate,
  // which every surface then renders as U+FFFD.
  const truncated = sliceAtCodeUnitLimit(
    collapsed,
    AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH
  ).replace(TRAILING_DANGLE, '')
  return truncated || null
}

export function isAgentSessionConversationName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH
  )
}
