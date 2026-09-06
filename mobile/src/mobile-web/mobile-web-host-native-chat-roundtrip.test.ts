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
            ? ['bind', 'read'].map((operation) => ({
                method: `mobileWeb.nativeChat.${operation}`,
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
  const bridge = createMobileWebBridgeRoundtripFixture({
    grants: MOBILE_WEB_PRODUCTION_GRANTS,
    ...(genericShell ? {} : { shellFeatures: [] }),
    rpcClient: { sendRequest } as unknown as RpcClient
  })
  return { ...bridge, sendRequest, transcript }
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
      expect(f.sendRequest).toHaveBeenCalledWith('mobileWeb.nativeChat.bind', {
        worktree: 'id:host-workspace',
        pageSession: MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT.shellSessionId,
        tabId: 'tab'
      })
      expect(f.sendRequest).toHaveBeenCalledWith('mobileWeb.nativeChat.read', {
        worktree: 'id:host-workspace',
        pageSession: MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT.shellSessionId,
        resourceId: 'opaque-resource',
        read: { limit: 20 }
      })
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
})
