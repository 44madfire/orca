// The conversation name a provider gives one structured chat, normalized once
// so every surface that shows it agrees on the text.
//
// Providers publish this as free text a user can also edit from another client,
// so it is bounded and flattened here rather than at each display site: a name
// carrying a newline would break the tab strip and the sidebar row alike.

/** Well past any provider's own cap, short enough that a pasted essay cannot become a tab label. */
export const AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH = 200

export function normalizeAgentSessionConversationName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (!collapsed) {
    return null
  }
  return collapsed.length > AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH
    ? collapsed.slice(0, AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH).trimEnd()
    : collapsed
}

export function isAgentSessionConversationName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH
  )
}
