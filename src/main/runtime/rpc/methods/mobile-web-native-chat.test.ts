import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeChatPageFixture as fixture } from './mobile-web-native-chat-test-fixture'
import { MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES } from '../../../../shared/mobile-web/native-chat-operation-contract'
const read = vi.hoisted(() => vi.fn())
vi.mock('./native-chat', async () => {
  const { z } = await import('zod')
  return {
    NATIVE_CHAT_METHODS: [
      { name: 'nativeChat.readSession', params: z.object({}).passthrough(), handler: read }
    ]
  }
})
import { MOBILE_WEB_NATIVE_CHAT_METHODS } from './mobile-web-native-chat'
const bind = MOBILE_WEB_NATIVE_CHAT_METHODS[0]
const reader = MOBILE_WEB_NATIVE_CHAT_METHODS[1]
beforeEach(() => read.mockReset())
describe('Desktop native-chat page adapter', () => {
  it.each(['界', '\u0000'])(
    'keeps large %s transcripts readable within the bridge byte ceiling',
    async (character) => {
      const f = fixture()
      const resource = await bind.handler({ ...f.scope, tabId: 'tab' }, f.context)
      const messages = Array.from({ length: 8 }, (_, index) => ({
        id: `message-${index}`,
        role: 'assistant',
        source: 'transcript',
        timestamp: index,
        future: { field: true },
        blocks: [{ type: 'text', text: character.repeat(64_000), futureBlockField: 'preserved' }]
      }))
      const raw = { messages, hasMore: true, beforeOffset: 42, futureLifecycle: 'new' }
      read.mockResolvedValue(raw)
      const result = (await reader.handler(
        { ...f.scope, ...(resource as object), read: { limit: 8, beforeOffset: 100 } },
        f.context
      )) as typeof raw
      expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(
        MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES
      )
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES
      )
      expect(result).toMatchObject({ hasMore: true, beforeOffset: 42, futureLifecycle: 'new' })
      expect(result.messages.map(({ id }) => id)).toEqual(messages.map(({ id }) => id))
      for (const message of result.messages) {
        expect(message.future).toEqual({ field: true })
        expect(message.blocks[0].futureBlockField).toBe('preserved')
        expect(message.blocks[0].text).toContain('(truncated)')
        expect(message.blocks[0].text.startsWith(character)).toBe(true)
      }
      expect(raw.messages[0].blocks[0].text).toHaveLength(64_000)
    }
  )

  it('bounds oversized tool and future blocks without discarding messages or the pagination cursor', async () => {
    const f = fixture()
    const resource = await bind.handler({ ...f.scope, tabId: 'tab' }, f.context)
    const raw = {
      messages: Array.from({ length: 40 }, (_, index) => ({
        id: `message-${index}`,
        blocks: [
          { type: 'future-block', field: 'retained' },
          { type: 'tool-call', input: { payload: 'x'.repeat(100_000) } }
        ]
      })),
      hasMore: true,
      beforeOffset: 123
    }
    read.mockResolvedValue(raw)
    const result = (await reader.handler(
      { ...f.scope, ...(resource as object), read: {} },
      f.context
    )) as typeof raw
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES
    )
    expect(result.messages).toHaveLength(40)
    expect(result.beforeOffset).toBe(123)
    expect(result.messages[0].blocks).toEqual([
      { type: 'future-block', field: 'retained' },
      { type: 'text', text: '\n… (truncated)' }
    ])
  })

  it('resolves opaque identities and preserves future transcript fields without shell projections', async () => {
    const f = fixture()
    const result = { messages: [{ future: { field: true } }], futureLifecycle: 'new' }
    read.mockResolvedValue(result)
    const resource = (await bind.handler({ ...f.scope, tabId: 'tab' }, f.context)) as {
      resourceId: string
    }
    expect(JSON.stringify(resource)).not.toContain('provider-session')
    expect(JSON.stringify(resource)).not.toContain('/private')
    expect(
      await reader.handler(
        {
          ...f.scope,
          ...resource,
          read: {
            limit: 30,
            sessionId: 'forged',
            transcriptPath: '/forged',
            worktreeId: 'forged',
            terminal: 'forged'
          }
        },
        f.context
      )
    ).toEqual(result)
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 30,
        agent: 'codex',
        sessionId: 'provider-session',
        transcriptPath: '/private/transcript',
        terminal: 'host-terminal',
        worktreeId: 'host-workspace'
      }),
      f.context
    )
  })

  it('refuses replaced bindings before reading and after asynchronous reads', async () => {
    for (const duringRead of [false, true]) {
      const f = fixture()
      const resource = (await bind.handler({ ...f.scope, tabId: 'tab' }, f.context)) as {
        resourceId: string
      }
      const replace = () =>
        f.listMobileSessionTabs.mockResolvedValue({
          worktree: 'host-workspace',
          tabs: [{ ...f.tab, terminal: 'replacement' }]
        })
      if (duringRead) {
        read.mockImplementationOnce(async () => {
          replace()
          return { messages: [] }
        })
      } else {
        replace()
      }
      await expect(
        reader.handler({ ...f.scope, ...resource, read: {} }, f.context)
      ).rejects.toThrow('selector_not_found')
    }
  })

  it('preserves a handle across an unverifiable snapshot failure', async () => {
    const f = fixture()
    const resource = (await bind.handler({ ...f.scope, tabId: 'tab' }, f.context)) as {
      resourceId: string
    }
    f.listMobileSessionTabs.mockRejectedValueOnce(new Error('Connection unavailable'))
    await expect(reader.handler({ ...f.scope, ...resource, read: {} }, f.context)).rejects.toThrow(
      'Connection unavailable'
    )
    read.mockResolvedValueOnce({ messages: [] })
    expect(await reader.handler({ ...f.scope, ...resource, read: {} }, f.context)).toEqual({
      messages: []
    })
  })
})
