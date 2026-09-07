import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentSessionNamingPromptText } from './agent-session-naming-prompt-text'

function body(blocks: unknown[]): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks } as unknown as AgentJournalMessageItem
}

describe('agentSessionNamingPromptText', () => {
  it('joins the submission’s text blocks', () => {
    expect(
      agentSessionNamingPromptText(
        body([
          { type: 'text', text: 'fix the flaky lease probe' },
          { type: 'text', text: 'it fails on Windows' }
        ])
      )
    ).toBe('fix the flaky lease probe\nit fails on Windows')
  })

  it('leaves image paths out, so no filesystem location reaches a title', () => {
    expect(
      agentSessionNamingPromptText(
        body([
          { type: 'image-ref', path: '/Users/someone/secret/design.png' },
          { type: 'text', text: 'match this' }
        ])
      )
    ).toBe('match this')
  })

  it('reports null when there is nothing to title', () => {
    expect(agentSessionNamingPromptText(body([]))).toBeNull()
    expect(agentSessionNamingPromptText(body([{ type: 'text', text: '   ' }]))).toBeNull()
    expect(
      agentSessionNamingPromptText(body([{ type: 'image-ref', path: '/tmp/a.png' }]))
    ).toBeNull()
  })

  it('bounds a pasted file so it cannot become the whole request', () => {
    const text = agentSessionNamingPromptText(body([{ type: 'text', text: 'a'.repeat(9_000) }]))
    expect(text).toHaveLength(2_000)
  })
})
