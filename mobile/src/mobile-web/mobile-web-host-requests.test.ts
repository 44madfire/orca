import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebHostRequest } from './mobile-web-host-requests'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'

const grant = {
  method: 'future.domainRead',
  workspaceParam: 'worktree',
  maxRequestBytes: 16 * 1024,
  maxResponseBytes: 512 * 1024
}

function fixture() {
  const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(1))
  authority.synchronize([{ workspaceId: 'host-workspace', repoId: 'host-repo' }])
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const args = {
    authority,
    client: { sendRequest } as unknown as RpcClient,
    isActive: () => true,
    payload: {
      method: grant.method,
      workspaceId: authority.pageWorkspaceId('host-workspace'),
      params: { futureField: { futureVariant: 'added-by-desktop' } }
    }
  }
  return { args, sendRequest }
}

describe('host-advertised unary forwarding', () => {
  it('forwards future fields and methods without a shell method entry', async () => {
    const { args, sendRequest } = fixture()
    const result = { futureResult: [{ kind: 'future-kind', value: 4 }] }
    sendRequest
      .mockResolvedValueOnce({ ok: true, result: { grants: [grant] } })
      .mockResolvedValueOnce({ ok: true, result })
    await expect(executeMobileWebHostRequest(args)).resolves.toEqual(result)
    expect(sendRequest).toHaveBeenLastCalledWith(
      grant.method,
      {
        ...args.payload.params,
        worktree: 'id:host-workspace'
      },
      expect.objectContaining({ beforeSend: expect.any(Function), budgetSpansConnect: true })
    )
    expect(JSON.stringify(result)).not.toContain('host-workspace')
  })

  it('overwrites page-authored scope with the current shell document identity', async () => {
    const { args, sendRequest } = fixture()
    sendRequest
      .mockResolvedValueOnce({
        ok: true,
        result: { grants: [{ ...grant, pageSessionParam: 'pageSession' }] }
      })
      .mockResolvedValueOnce({ ok: true, result: {} })
    await executeMobileWebHostRequest({
      ...args,
      getPageSessionId: async () => 'current-document',
      payload: { ...args.payload, params: { pageSession: 'retired-document' } }
    })
    expect(sendRequest).toHaveBeenLastCalledWith(
      grant.method,
      {
        worktree: 'id:host-workspace',
        pageSession: 'current-document'
      },
      expect.objectContaining({ beforeSend: expect.any(Function) })
    )
  })

  it.each(['cancel', 'rebind'] as const)('revalidates %s at transport dispatch', async (change) => {
    const { args, sendRequest } = fixture()
    let active = true
    args.isActive = () => active
    sendRequest.mockResolvedValueOnce({ ok: true, result: { grants: [grant] } })
    sendRequest.mockImplementationOnce(async (_method, _params, options) => {
      if (change === 'cancel') {
        active = false
      } else {
        args.authority.clear()
      }
      options?.beforeSend?.()
      throw new Error('Transport must not write')
    })
    await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({
      code: change === 'cancel' ? 'cancelled' : 'not_found'
    })
  })

  it('refuses a scoped method without native document authority', async () => {
    const { args, sendRequest } = fixture()
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { grants: [{ ...grant, pageSessionParam: 'pageSession' }] }
    })
    await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({
      code: 'unsupported_capability'
    })
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('refuses methods the desktop did not advertise', async () => {
    const { args, sendRequest } = fixture()
    sendRequest.mockResolvedValueOnce({ ok: true, result: { grants: [] } })
    await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({
      code: 'unsupported_capability'
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('does not forward after authority retirement during catalog lookup', async () => {
    const { args, sendRequest } = fixture()
    sendRequest.mockImplementationOnce(async () => {
      args.authority.clear()
      return { ok: true, result: { grants: [grant] } }
    })
    await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({ code: 'not_found' })
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('keeps native hard ceilings even when the trusted host permits a larger result', async () => {
    const { args, sendRequest } = fixture()
    sendRequest
      .mockResolvedValueOnce({
        ok: true,
        result: { grants: [{ ...grant, maxResponseBytes: 10_000_000 }] }
      })
      .mockResolvedValueOnce({ ok: true, result: { text: 'x'.repeat(640 * 1024) } })
    await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({ code: 'too_large' })
  })

  it('enforces host request bounds before executing', async () => {
    const { args, sendRequest } = fixture()
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { grants: [{ ...grant, maxRequestBytes: 1 }] }
    })
    await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({ code: 'too_large' })
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('retains in-flight admission after page cancellation until host work settles', async () => {
    const finishCatalog: (() => void)[] = []
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockImplementation(async (method) => {
      if (method === 'worktree.ps') {
        return {
          ok: true,
          result: {
            worktrees: [{ worktreeId: 'host-workspace', repo: '/repo', displayName: 'Workspace' }]
          }
        }
      }
      return new Promise((resolve) =>
        finishCatalog.push(() =>
          resolve({
            ok: true,
            result: { grants: [{ ...grant, method: 'mobileWeb.sourceControl.status' }] }
          })
        )
      )
    })
    const { client } = createMobileWebBridgeRoundtripFixture({
      grants: MOBILE_WEB_PRODUCTION_GRANTS,
      rpcClient: { sendRequest } as unknown as RpcClient
    })
    const snapshot = await client.workspaceSnapshot({ limit: 10 })
    const payload = { workspaceId: snapshot.workspaces[0]!.id, limit: 10 }
    for (let i = 0; i < 4; i++) {
      const controller = new AbortController()
      const pending = client.sourceControlStatus(payload, { signal: controller.signal })
      const rejection = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
      controller.abort()
      await rejection
    }
    await expect(client.sourceControlStatus(payload)).rejects.toMatchObject({
      code: 'rate_limited'
    })
    expect(finishCatalog).toHaveLength(4)
    finishCatalog.forEach((finish) => finish())
  })

  it('renders bounded Desktop status through the host catalog', async () => {
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
        return {
          ok: true,
          result: { grants: [{ ...grant, method: 'mobileWeb.sourceControl.status' }] }
        }
      }
      expect(method).toBe('mobileWeb.sourceControl.status')
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
    const { client, pageMessages } = createMobileWebBridgeRoundtripFixture({
      grants: MOBILE_WEB_PRODUCTION_GRANTS,
      rpcClient: { sendRequest } as unknown as RpcClient
    })
    const snapshot = await client.workspaceSnapshot({ limit: 10 })
    const workspaceId = snapshot.workspaces[0]!.id
    await expect(client.sourceControlStatus({ workspaceId, limit: 10 })).resolves.toMatchObject({
      workspaceId,
      branch: 'main',
      entries: []
    })
    expect(
      pageMessages.some(
        (message) => message.type === 'request' && message.operation === 'hostRequest'
      )
    ).toBe(true)
    expect(
      pageMessages.some((message) => message.type === 'request' && message.operation === 'status')
    ).toBe(false)
  })
})
