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

describe('normalizeAgentSessionConversationName hostile text', () => {
  it('strips control characters and bidi overrides', () => {
    // U+202E renders what follows right-to-left, so a tab could show a label
    // that reads as text the name does not contain.
    expect(normalizeAgentSessionConversationName('Fix\u202Egnp.exe probe')).toBe(
      'Fix gnp.exe probe'
    )
    expect(normalizeAgentSessionConversationName('Fix\u0007the probe')).toBe('Fix the probe')
    expect(normalizeAgentSessionConversationName('Fix\u200Bthe probe')).toBe('Fix the probe')
    expect(normalizeAgentSessionConversationName('\u202E\u200B ')).toBeNull()
  })

  it('never truncates through a surrogate pair', () => {
    const name = `${'a'.repeat(AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH - 1)}\u{1F600}tail`

    const normalized = normalizeAgentSessionConversationName(name)

    // A raw slice would leave the emoji's lone high surrogate, which renders as
    // U+FFFD on every surface that shows the name.
    expect(normalized).toBe('a'.repeat(AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH - 1))
    expect(normalized).not.toContain('\uFFFD')
  })

  it('keeps a legitimate non-ASCII name intact', () => {
    expect(normalizeAgentSessionConversationName('R\u00E9sum\u00E9 du fil \u2615')).toBe(
      'R\u00E9sum\u00E9 du fil \u2615'
    )
  })
})
