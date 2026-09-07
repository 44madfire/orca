import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH,
  isAgentSessionConversationName,
  normalizeAgentSessionConversationName
} from './agent-session-conversation-name'

describe('normalizeAgentSessionConversationName', () => {
  it('keeps a plain single-line name unchanged', () => {
    expect(normalizeAgentSessionConversationName('Fix the flaky lease probe')).toBe(
      'Fix the flaky lease probe'
    )
  })

  it('flattens whitespace so a multi-line name cannot break the tab strip', () => {
    expect(normalizeAgentSessionConversationName('Fix  the\nlease\tprobe  ')).toBe(
      'Fix the lease probe'
    )
  })

  it('rejects an empty or whitespace-only name rather than blanking the label', () => {
    expect(normalizeAgentSessionConversationName('')).toBeNull()
    expect(normalizeAgentSessionConversationName('   \n ')).toBeNull()
  })

  it('rejects anything that is not a string', () => {
    expect(normalizeAgentSessionConversationName(undefined)).toBeNull()
    expect(normalizeAgentSessionConversationName(null)).toBeNull()
    expect(normalizeAgentSessionConversationName(42)).toBeNull()
    expect(normalizeAgentSessionConversationName({ title: 'x' })).toBeNull()
  })

  it('bounds a pasted essay to the stored maximum', () => {
    const normalized = normalizeAgentSessionConversationName('a'.repeat(1000))
    expect(normalized).toHaveLength(AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH)
    expect(isAgentSessionConversationName(normalized)).toBe(true)
  })
})

describe('isAgentSessionConversationName', () => {
  it('accepts a bounded non-empty string and nothing else', () => {
    expect(isAgentSessionConversationName('Fix the probe')).toBe(true)
    expect(isAgentSessionConversationName('')).toBe(false)
    expect(isAgentSessionConversationName('a'.repeat(201))).toBe(false)
    expect(isAgentSessionConversationName(7)).toBe(false)
  })
})
