import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeChatPageFixture as fixture } from './mobile-web-native-chat-test-fixture'
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
