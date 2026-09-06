import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  createMobileWebBridgeRoundtripFixture,
  MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT
} from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

function fixture(genericHost = true, genericShell = true) {
  const transcript = {
    messages: [
      {
        id: 'm',
        role: 'assistant',
        source: 'transcript',
        timestamp: null,
        blocks: [{ type: 'text', text: 'hello', futureFormatting: 'rich' }],
        futureProviderField: { revision: 2 }
      }
    ],
    hasMore: false,
    futureLifecycle: 'new'
  }
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) => {
    if (method === 'worktree.ps') {
      return {
        ok: true,
        result: {
          worktrees: [
            { worktreeId: 'host-workspace', repo: '/private/repo', displayName: 'Workspace' }
          ]
        }
      }
    }
    if (method === 'session.tabs.list') {
      return {
        ok: true,
        result: {
          worktree: 'host-workspace',
          publicationEpoch: 'epoch',
          snapshotVersion: 1,
          activeTabId: 'tab',
          activeTabType: 'terminal',
          tabs: [
            {
              id: 'tab',
              type: 'terminal',
              terminal: 'private-terminal',
              title: 'Chat',
              isActive: true,
              agentStatus: { agentType: 'codex', providerSession: { id: 'private-session' } }
            }
          ]
        }
      }
    }
    if (method === 'mobileWeb.host.catalog') {
      return {
        ok: true,
        result: {
          grants: genericHost
            ? ['bind', 'read', 'subscribe'].map((operation) => ({
                method: `mobileWeb.nativeChat.${operation}`,
                ...(operation === 'subscribe'
                  ? { mode: 'subscription', unsubscribeMethod: 'nativeChat.unsubscribe' }
                  : {}),
                workspaceParam: 'worktree',
                pageSessionParam: 'pageSession',
                maxRequestBytes: 16384,
                maxResponseBytes: 524288
              }))
            : []
        }
      }
    }
    if (method === 'mobileWeb.nativeChat.bind') {
      return { ok: true, result: { resourceId: 'opaque-resource' } }
    }
    return { ok: true, result: transcript }
  })
  let emit: (event: unknown) => void = () => {}
  const unsubscribe = vi.fn()
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, listener) => {
    emit = listener
    return unsubscribe
  })
  const bridge = createMobileWebBridgeRoundtripFixture({
    grants: MOBILE_WEB_PRODUCTION_GRANTS,
    ...(genericShell ? {} : { shellFeatures: [] }),
    rpcClient: { sendRequest, subscribe } as unknown as RpcClient
  })
  return {
    ...bridge,
    sendRequest,
    transcript,
    subscribe,
    unsubscribe,
    emit: (event: unknown) => emit(event)
  }
}

describe('native-chat generic read migration', () => {
  it.each([
    [true, true],
    [false, true],
    [true, false]
  ])('host=%s shell=%s', async (host, shell) => {
    const f = fixture(host, shell)
    const workspaceId = (await f.client.workspaceSnapshot({ limit: 10 })).workspaces[0]!.id
    const session = await f.client.sessionSnapshot({ workspaceId })
    const tab = session.tabs.find((tab) => tab.type === 'terminal')!
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Missing chat fixture')
    }
    const result = await f.client.nativeChat.readForTab(
      { workspaceId, sessionId: tab.nativeChatSessionId, limit: 20 },
      tab.id
    )
    expect(result.messages[0].blocks[0]).toMatchObject({ type: 'text', text: 'hello' })
    if (host && shell) {
      expect(result).toEqual(f.transcript)
      expect(f.sendRequest).toHaveBeenCalledWith(
        'mobileWeb.nativeChat.bind',
        {
          worktree: 'id:host-workspace',
          pageSession: MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT.shellSessionId,
          tabId: 'tab'
        },
        expect.objectContaining({ beforeSend: expect.any(Function) })
      )
      expect(f.sendRequest).toHaveBeenCalledWith(
        'mobileWeb.nativeChat.read',
        {
          worktree: 'id:host-workspace',
          pageSession: MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT.shellSessionId,
          resourceId: 'opaque-resource',
          read: { limit: 20 }
        },
        expect.objectContaining({ beforeSend: expect.any(Function) })
      )
      expect(f.sendRequest.mock.calls.some(([method]) => method === 'nativeChat.readSession')).toBe(
        false
      )
    } else {
      expect(
        f.sendRequest.mock.calls.some(([method]) => method === 'mobileWeb.nativeChat.bind')
      ).toBe(false)
      expect(f.sendRequest.mock.calls.some(([method]) => method === 'nativeChat.readSession')).toBe(
        true
      )
    }
    expect(JSON.stringify(f.shellMessages)).not.toContain('private-session')
  })
  it.each([
    [true, true],
    [false, true],
    [true, false]
  ])('stream host=%s shell=%s', async (host, shell) => {
    const f = fixture(host, shell)
    const workspaceId = (await f.client.workspaceSnapshot({ limit: 10 })).workspaces[0]!.id
    const session = await f.client.sessionSnapshot({ workspaceId })
    const tab = session.tabs[0]
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Missing chat fixture')
    }
    const onEvent = vi.fn()
    const subscription = f.client.nativeChat.subscribeForTab(
      tab.id,
      { workspaceId, sessionId: tab.nativeChatSessionId, limit: 20 },
      onEvent,
      vi.fn()
    )
    await subscription.ready
    const generic = host && shell
    expect(f.subscribe.mock.calls[0][0]).toBe(
      generic ? 'mobileWeb.nativeChat.subscribe' : 'nativeChat.subscribe'
    )
    const event = { type: 'snapshot', ...f.transcript }
    f.emit(event)
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce())
    if (generic) {
      expect(onEvent).toHaveBeenCalledWith(event)
      expect(f.subscribe.mock.calls[0][1]).toMatchObject({
        pageSession: MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT.shellSessionId,
        resourceId: 'opaque-resource'
      })
    }
    subscription.unsubscribe()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })
  it('does not subscribe after cancellation during host binding', async () => {
    const f = fixture()
    const workspaceId = (await f.client.workspaceSnapshot({ limit: 10 })).workspaces[0]!.id
    const session = await f.client.sessionSnapshot({ workspaceId })
    const tab = session.tabs[0]
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Missing chat fixture')
    }
    const original = f.sendRequest.getMockImplementation()!
    const bound = Promise.withResolvers<Awaited<ReturnType<RpcClient['sendRequest']>>>()
    f.sendRequest.mockImplementation((...args) =>
      args[0] === 'mobileWeb.nativeChat.bind' ? bound.promise : original(...args)
    )
    const onError = vi.fn()
    const subscription = f.client.nativeChat.subscribeForTab(
      tab.id,
      { workspaceId, sessionId: tab.nativeChatSessionId, limit: 20 },
      vi.fn(),
      onError
    )
    await vi.waitFor(() =>
      expect(
        f.sendRequest.mock.calls.some(([method]) => method === 'mobileWeb.nativeChat.bind')
      ).toBe(true)
    )
    subscription.unsubscribe()
    bound.resolve({ ok: true, result: { resourceId: 'opaque-resource' } })
    await expect(subscription.ready).rejects.toMatchObject({ code: 'cancelled' })
    expect(f.subscribe).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
