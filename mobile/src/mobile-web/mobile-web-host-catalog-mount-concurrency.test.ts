import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

const mountCatalogs = [
  ['mobileWeb.nativeChat.bind', 'mobileWeb.nativeChat.read'],
  ['mobileWeb.nativeChat.bind', 'mobileWeb.nativeChat.subscribe'],
  ['mobileWeb.terminal.bind', 'mobileWeb.terminal.action']
]

describe('host catalog admission during a chat mount', () => {
  it('serves parallel chat read, feed and terminal metadata discovery within shell limits', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (_method, input) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      const { methods } = input as { methods: string[] }
      return {
        ok: true,
        result: {
          grants: methods.map((method) => ({
            method,
            workspaceParam: 'worktree',
            pageSessionParam: 'pageSession',
            maxRequestBytes: 16384,
            maxResponseBytes: 524288
          }))
        }
      }
    })
    const { client, shellMessages } = createMobileWebBridgeRoundtripFixture({
      grants: MOBILE_WEB_PRODUCTION_GRANTS,
      rpcClient: { sendRequest } as unknown as RpcClient
    })
    const results = await Promise.allSettled(
      mountCatalogs.map((methods) => client.host.catalog(methods))
    )
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    expect(
      shellMessages.filter((message) => message.type === 'response' && message.status === 'error')
    ).toEqual([])
  })
})
