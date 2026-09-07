import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebHostRequest } from './mobile-web-host-requests'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MobileWebHostSubscriptions } from './mobile-web-host-subscriptions'

const grant = {
  method: 'future.hostSetting',
  scope: 'host',
  maxRequestBytes: 1024,
  maxResponseBytes: 1024
}
function fixture() {
  const sendRequest = vi
    .fn<RpcClient['sendRequest']>()
    .mockResolvedValueOnce({ ok: true, result: { grants: [grant] } })
    .mockResolvedValue({ ok: true, result: { futureField: { value: 42 } } })
  return {
    sendRequest,
    args: {
      authority: new MobileWebWorkspaceAuthority((length) => new Uint8Array(length)),
      client: { sendRequest } as unknown as RpcClient,
      isActive: () => true,
      payload: { method: grant.method, params: { enabled: false } }
    }
  }
}

describe('generic requests scoped to a paired host', () => {
  it('forwards a host-scoped method with zero workspaces and no injected scope', async () => {
    const { args, sendRequest } = fixture()
    sendRequest
      .mockReset()
      .mockResolvedValueOnce({ ok: true, result: { grants: [grant] } })
      .mockResolvedValue({ ok: true, result: { futureField: { value: 42 } } })
    await expect(executeMobileWebHostRequest(args)).resolves.toEqual({
      futureField: { value: 42 }
    })
    expect(sendRequest).toHaveBeenLastCalledWith(
      grant.method,
      { enabled: false },
      expect.any(Object)
    )
  })

  it('does not downgrade a workspace method to host scope', async () => {
    const { args, sendRequest } = fixture()
    sendRequest.mockReset().mockResolvedValue({
      ok: true,
      result: { grants: [{ ...grant, scope: 'workspace', workspaceParam: 'worktree' }] }
    })
    await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({
      code: 'unsupported_capability'
    })
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('retains the host/document dispatch fence without workspace authority', async () => {
    const { args, sendRequest } = fixture()
    let active = true
    args.isActive = () => active
    sendRequest
      .mockReset()
      .mockResolvedValueOnce({ ok: true, result: { grants: [grant] } })
      .mockImplementationOnce(async (_method, _params, options) => {
        active = false
        options?.beforeSend?.()
        throw new Error('Host request must not be written')
      })
    await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('forwards host-scoped requests without an obsolete shell feature flag', async () => {
    const { args } = fixture()
    const f = createMobileWebBridgeRoundtripFixture({
      grants: MOBILE_WEB_PRODUCTION_GRANTS,
      rpcClient: args.client,
      shellFeatures: []
    })
    await expect(f.client.host.request(args.payload)).resolves.toEqual({
      futureField: { value: 42 }
    })
    const message = f.pageMessages.find((frame) => frame.type === 'request')
    expect(message).toMatchObject({ operation: 'hostRequest', payload: args.payload })
  })

  it('retains generic subscription cleanup for host-wide feeds', async () => {
    const { args, sendRequest } = fixture()
    sendRequest.mockReset().mockResolvedValue({
      ok: true,
      result: {
        grants: [
          {
            ...grant,
            mode: 'subscription',
            unsubscribeMethod: 'future.hostStop'
          }
        ]
      }
    })
    let emit: (event: unknown) => void = () => {}
    const cleanup = vi.fn()
    const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, listener) => {
      emit = listener
      return cleanup
    })
    const postEvent = vi.fn()
    const ledger = new MobileWebHostSubscriptions({
      workspaceAuthority: args.authority,
      isActive: () => true,
      postEvent,
      postClosed: vi.fn()
    })
    await ledger.start({
      ...args,
      client: { sendRequest, subscribe } as unknown as RpcClient,
      requestId: 'request',
      subscriptionId: 'subscription'
    })
    emit({ type: 'future', setting: 7 })
    await vi.waitFor(() =>
      expect(postEvent).toHaveBeenCalledWith('subscription', 0, { type: 'future', setting: 7 })
    )
    expect(subscribe).toHaveBeenCalledWith(
      grant.method,
      args.payload.params,
      expect.any(Function),
      { serverUnsubscribeMethod: 'future.hostStop' }
    )
    ledger.cancel('subscription')
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
