import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

function fixture(catalogAvailable = true, genericShell = true) {
  let emit: (event: unknown) => void = () => {}
  const unsubscribe = vi.fn()
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, listener) => {
    emit = listener
    return unsubscribe
  })
  const sendRequest = vi.fn<RpcClient['sendRequest']>().mockImplementation(async (method) => {
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
    return catalogAvailable
      ? {
          ok: true,
          result: {
            grants: [
              {
                method: 'mobileWeb.files.watch',
                mode: 'subscription',
                workspaceParam: 'worktree',
                unsubscribeMethod: 'files.unwatch',
                maxRequestBytes: 1024,
                maxResponseBytes: 512 * 1024
              },
              {
                method: 'future.events',
                mode: 'subscription',
                workspaceParam: 'scope',
                unsubscribeMethod: 'future.release',
                maxRequestBytes: 1024,
                maxResponseBytes: 512 * 1024
              }
            ]
          }
        }
      : { ok: false, error: { code: 'method_not_found', message: 'Old host' } }
  })
  const bridge = createMobileWebBridgeRoundtripFixture({
    grants: MOBILE_WEB_PRODUCTION_GRANTS.filter(
      (grant) => genericShell || grant.operation !== 'hostSubscribe'
    ),
    rpcClient: { sendRequest, subscribe } as unknown as RpcClient
  })
  return { ...bridge, subscribe, unsubscribe, emit: (event: unknown) => emit(event) }
}

describe('generic subscription bridge compatibility', () => {
  it.each([[true, true]])('source-control catalog=%s shell=%s', async (catalog, shell) => {
    const f = fixture(catalog, shell)
    const workspace = (await f.client.workspaceSnapshot({ limit: 10 })).workspaces[0]!.id
    const onEvent = vi.fn()
    const onError = vi.fn()
    const subscription = f.client.sourceControlSubscribe(
      { workspaceId: workspace },
      onEvent,
      onError
    )
    await subscription.ready
    const generic = catalog && shell
    expect(f.subscribe.mock.calls[0]?.[0]).toBe(generic ? 'mobileWeb.files.watch' : 'files.watch')
    f.emit({
      type: 'changed',
      ...(generic ? {} : { worktree: 'id:host-workspace' }),
      events: [],
      futureField: 'new'
    })
    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith({ workspaceId: workspace, reason: 'changed' })
    )
    expect(onError).not.toHaveBeenCalled()
    subscription.unsubscribe()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })

  it('forwards a future method and event without adding a domain operation', async () => {
    const f = fixture()
    const workspaceId = (await f.client.workspaceSnapshot({ limit: 10 })).workspaces[0]!.id
    const onEvent = vi.fn()
    const subscription = f.client.hostSubscribe(
      { method: 'future.events', workspaceId, params: { newParam: 42 } },
      onEvent,
      vi.fn()
    )
    await subscription.ready
    const event = { futureKind: 'unknown-to-shell', fields: { addedLater: true } }
    f.emit(event)
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(event))
    expect(f.subscribe).toHaveBeenCalledWith(
      'future.events',
      { scope: 'id:host-workspace', newParam: 42 },
      expect.any(Function),
      { serverUnsubscribeMethod: 'future.release' }
    )
    subscription.unsubscribe()
  })
})
