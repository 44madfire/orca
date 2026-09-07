import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_MESSAGE_BLOCK_LIMIT,
  MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_READ_LIMIT,
  MobileWebNativeChatReadResultSchema
} from '../../../../shared/mobile-web/native-chat-operation-contract'
import { tolerantMobileWebShellPayload } from '../../../../shared/mobile-web/shell-payload-tolerance'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { MOBILE_NATIVE_CHAT_MAX_WINDOW, windowForClient } from './native-chat-rpc-message-sanitizer'
import { clipMobileWebNativeChatToPageContract } from './mobile-web-native-chat-page-contract-clip'

// The page parses the shell-relayed read with the tolerant rewrite, never the raw strict schema.
const pageContract = tolerantMobileWebShellPayload(MobileWebNativeChatReadResultSchema)
const ESC = String.fromCharCode(27)

function asPage(messages: unknown[]) {
  return pageContract.safeParse({ messages, hasMore: false })
}

function clipped(messages: unknown[]) {
  const result = clipMobileWebNativeChatToPageContract({ messages, hasMore: false })
  return (result as { messages: unknown[] }).messages
}

function sanitized(messages: unknown[]) {
  return windowForClient(messages as NativeChatMessage[], 'mobile')
}

function message(id: string, blocks: unknown[]) {
  return { id, role: 'assistant', blocks, timestamp: 1, source: 'transcript' }
}

describe('native chat sanitizer against the page contract', () => {
  it('keeps an adversarial transcript parseable and strips what the page cannot name', () => {
    const parsed = asPage(
      sanitized([
        message('turn-1', [
          {
            type: 'text',
            text: `${ESC}]0;title${String.fromCharCode(7)}plain`,
            providerFrame: {
              provider: 'claude',
              kind: 'raw',
              payload: { head: 'h', byteLength: 4, digest: 'd', truncated: false }
            }
          },
          { type: 'diagram', nodes: [1, 2, 3] },
          { type: 'tool-call', name: 'Bash', input: { command: 'ls' }, state: 'running' },
          { type: 'tool-call', name: 'Read', input: {}, state: 'queued' },
          { type: 'tool-call', name: '', input: {} },
          {
            type: 'tool-result',
            output: 'o'.repeat(5000),
            isError: true,
            editPatch: { filePath: 'a.ts', hunks: [] }
          },
          { type: 'image-ref', path: 'p'.repeat(9000), url: 'data:image/png;base64,AAA', alt: 'ok' }
        ])
      ])
    )

    expect(parsed.success).toBe(true)
    expect(parsed.data?.messages[0]?.blocks).toEqual([
      { type: 'text', text: `${ESC}]0;title${String.fromCharCode(7)}plain` },
      { type: 'tool-call', name: 'Bash', input: { command: 'ls' }, state: 'running' },
      { type: 'tool-call', name: 'Read', input: {} },
      {
        type: 'tool-result',
        output: `${'o'.repeat(4000)}\n… (truncated)`,
        isError: true
      },
      { type: 'image-ref', alt: 'ok' }
    ])
  })

  it('keeps every tool-call lifecycle state the page names', () => {
    const states = ['running', 'completed', 'failed'] as const
    const parsed = asPage(
      sanitized([
        message(
          'turn-2',
          states.map((state) => ({ type: 'tool-call', name: 'Bash', input: {}, state }))
        )
      ])
    )

    expect(parsed.success).toBe(true)
    expect(
      parsed.data?.messages[0]?.blocks.map((block) => ('state' in block ? block.state : null))
    ).toEqual([...states])
  })

  it('bounds a hostile tool-call input inside the page block ceiling', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } }
    const wide = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`k${index}`, 'v'.repeat(200)])
    )
    const parsed = asPage(
      sanitized([message('turn-3', [{ type: 'tool-call', name: 'Bash', input: { deep, wide } }])])
    )

    expect(parsed.success).toBe(true)
    const block = parsed.data?.messages[0]?.blocks[0]
    expect(JSON.stringify(block).length).toBeLessThan(
      MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS * 2
    )
  })

  it('never returns more messages than the page read limit accepts', () => {
    const messages = Array.from({ length: MOBILE_WEB_NATIVE_CHAT_READ_LIMIT + 500 }, (_, index) =>
      message(`turn-${index}`, [{ type: 'text', text: 'hi' }])
    )

    expect(MOBILE_NATIVE_CHAT_MAX_WINDOW).toBe(MOBILE_WEB_NATIVE_CHAT_READ_LIMIT)
    const parsed = asPage(
      windowForClient(messages as NativeChatMessage[], 'mobile', messages.length)
    )
    expect(parsed.success).toBe(true)
    expect(parsed.data?.messages).toHaveLength(MOBILE_WEB_NATIVE_CHAT_READ_LIMIT)
  })

  // The desktop adapters clip sanitizer output to the page contract before it leaves the host;
  // these prove the raw sanitizer alone still needs that pass.
  it('text over the page ceiling needs the page-contract clip', () => {
    const text = 'a'.repeat(MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS + 1)
    const raw = asPage(sanitized([message('turn-4', [{ type: 'text', text }])]))
    expect(raw.data?.messages[0]?.blocks).toEqual([])

    const bounded = asPage(clipped(sanitized([message('turn-4', [{ type: 'text', text }])])))
    expect(bounded.data?.messages[0]?.blocks[0]).toMatchObject({ type: 'text' })
  })

  it('a turn over the page block limit needs the page-contract clip', () => {
    const blocks = Array.from({ length: MOBILE_WEB_NATIVE_CHAT_MESSAGE_BLOCK_LIMIT + 1 }, () => ({
      type: 'text',
      text: 'hi'
    }))
    expect(asPage(sanitized([message('turn-5', blocks)])).success).toBe(false)
    expect(asPage(clipped(sanitized([message('turn-5', blocks)]))).success).toBe(true)
  })

  it('a message id over the page ceiling needs the page-contract clip', () => {
    const id = 'x'.repeat(MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS + 1)
    expect(asPage(sanitized([message(id, [{ type: 'text', text: 'hi' }])])).success).toBe(false)
    const parsed = asPage(clipped(sanitized([message(id, [{ type: 'text', text: 'hi' }])])))
    expect(parsed.success).toBe(true)
    expect(parsed.data?.messages[0]?.id).toHaveLength(
      MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS
    )
  })
})
