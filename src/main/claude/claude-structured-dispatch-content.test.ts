import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { claudeDispatchMessageContent } from './claude-structured-dispatch-content'

function userMessage(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

const REMOTE_IMAGE = { type: 'image-ref' as const, url: 'https://example.test/a.png' }

describe('claudeDispatchMessageContent', () => {
  it('puts the text block last so a slash command still expands with an attachment', async () => {
    const content = await claudeDispatchMessageContent(
      // The composer builds text-then-images; Claude only treats a leading `/` as a
      // command when the LAST block is text.
      userMessage([{ type: 'text', text: '/goal ship the parser' }, REMOTE_IMAGE])
    )

    expect(content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
      { type: 'text', text: '/goal ship the parser' }
    ])
  })

  it('keeps every image ahead of the text and preserves each side’s order', async () => {
    const second = { type: 'image-ref' as const, url: 'https://example.test/b.png' }

    const content = await claudeDispatchMessageContent(
      userMessage([{ type: 'text', text: 'look' }, REMOTE_IMAGE, second])
    )

    expect(content.map((part) => (part as { type: string }).type)).toEqual([
      'image',
      'image',
      'text'
    ])
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.test/a.png' }
    })
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.test/b.png' }
    })
  })

  it('sends text alone unchanged', async () => {
    const content = await claudeDispatchMessageContent(userMessage([{ type: 'text', text: 'hi' }]))

    expect(content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('sends an image with no text', async () => {
    const content = await claudeDispatchMessageContent(userMessage([REMOTE_IMAGE]))

    expect(content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }
    ])
  })

  it('rejects a message with no renderable block', async () => {
    await expect(
      claudeDispatchMessageContent(userMessage([{ type: 'text', text: '' }]))
    ).rejects.toThrow('Claude dispatch requires text or an image')
  })

  it('rejects a non-user message', async () => {
    await expect(
      claudeDispatchMessageContent({
        ...userMessage([{ type: 'text', text: 'hi' }]),
        role: 'assistant'
      })
    ).rejects.toThrow('Claude dispatch accepts only user messages')
  })
})
