import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MobileWebHostCatalogCache } from './mobile-web-host-catalog-cache'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

const grant = {
  method: 'mobileWeb.sourceControl.status',
  workspaceParam: 'worktree',
  maxRequestBytes: 16 * 1024,
  maxResponseBytes: 512 * 1024
}

function cacheFixture() {
  const sendRequest = vi
    .fn<RpcClient['sendRequest']>()
    .mockImplementation(async (_method, input) => ({
      ok: true,
      result: {
        grants: (input as { methods: string[] }).methods
          .filter((method) => method !== 'future.absent')
          .map((method) => ({ ...grant, method }))
      }
    }))
  return { sendRequest, client: { sendRequest } as unknown as RpcClient }
}

describe('host catalog cache', () => {
  it('reads the desktop catalog once per method for a connection', async () => {
    const { sendRequest, client } = cacheFixture()
    const cache = new MobileWebHostCatalogCache()
    await expect(cache.grant(client, grant.method)).resolves.toMatchObject(grant)
    await expect(cache.grant(client, grant.method)).resolves.toMatchObject(grant)
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('collapses concurrent first reads of one method into a single catalog RPC', async () => {
    const { sendRequest, client } = cacheFixture()
    const cache = new MobileWebHostCatalogCache()
    const resolved = await Promise.all([
      cache.grant(client, grant.method),
      cache.grant(client, grant.method),
      cache.grant(client, grant.method)
    ])
    expect(resolved.every((entry) => entry?.method === grant.method)).toBe(true)
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('remembers a method the desktop refused to advertise', async () => {
    const { sendRequest, client } = cacheFixture()
    const cache = new MobileWebHostCatalogCache()
    await expect(cache.grant(client, 'future.absent')).resolves.toBeNull()
    await expect(cache.grant(client, 'future.absent')).resolves.toBeNull()
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('asks only for the methods it has not resolved yet', async () => {
    const { sendRequest, client } = cacheFixture()
    const cache = new MobileWebHostCatalogCache()
    await cache.read(client, { methods: [grant.method, 'future.absent'] })
    await expect(cache.read(client, { methods: [grant.method, 'future.other'] })).resolves.toEqual({
      grants: [
        expect.objectContaining({ method: grant.method }),
        { ...grant, method: 'future.other' }
      ]
    })
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(sendRequest).toHaveBeenLastCalledWith(
      'mobileWeb.host.catalog',
      { methods: ['future.other'] },
      expect.any(Object)
    )
  })

  it('re-reads after a client swap discards the connection it was read from', async () => {
    const { sendRequest, client } = cacheFixture()
    const cache = new MobileWebHostCatalogCache()
    await cache.grant(client, grant.method)
    cache.clear()
    await cache.grant(client, grant.method)
    expect(sendRequest).toHaveBeenCalledTimes(2)
    await cache.grant({ sendRequest } as unknown as RpcClient, grant.method)
    expect(sendRequest).toHaveBeenCalledTimes(3)
  })

  it('lets a peer retry when the request that owned the shared read fails', async () => {
    const { sendRequest, client } = cacheFixture()
    const failure = { ok: false as const, error: { code: 'internal_error' } }
    sendRequest.mockResolvedValueOnce(failure)
    const cache = new MobileWebHostCatalogCache()
    const owner = cache.grant(client, grant.method)
    const peer = cache.grant(client, grant.method)
    await expect(owner).rejects.toMatchObject({ code: 'host_error' })
    await expect(peer).resolves.toMatchObject(grant)
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })
})

describe('host catalog reads across a broker client swap', () => {
  it('serves forwarded requests from one catalog read until the client is replaced', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockImplementation(async (method) => {
      if (method === 'worktree.ps') {
        return {
          ok: true,
          result: {
            worktrees: [{ worktreeId: 'host-workspace', repo: '/repo', displayName: 'Workspace' }]
          }
        }
      }
      if (method === 'mobileWeb.host.catalog') {
        return { ok: true, result: { grants: [grant] } }
      }
      return {
        ok: true,
        result: {
          entries: [],
          conflictOperation: 'unknown',
          branch: 'main',
          totalCount: 0,
          truncated: false
        }
      }
    })
    const client = { sendRequest } as unknown as RpcClient
    const fixture = createMobileWebBridgeRoundtripFixture({
      grants: MOBILE_WEB_PRODUCTION_GRANTS,
      rpcClient: client
    })
    const statusPayload = async () => {
      const snapshot = await fixture.client.workspaceSnapshot({ limit: 10 })
      return { workspaceId: snapshot.workspaces[0]!.id, limit: 10 }
    }
    const payload = await statusPayload()
    const catalogReads = () =>
      sendRequest.mock.calls.filter(([method]) => method === 'mobileWeb.host.catalog').length

    await Promise.all([
      fixture.client.sourceControlStatus(payload),
      fixture.client.sourceControlStatus(payload)
    ])
    await fixture.client.sourceControlStatus(payload)
    expect(catalogReads()).toBe(1)

    // The swap retires every page handle too, so the page rediscovers its workspace first.
    fixture.broker.replaceClient(client)
    await fixture.client.sourceControlStatus(await statusPayload())
    expect(catalogReads()).toBe(2)
  })
})
