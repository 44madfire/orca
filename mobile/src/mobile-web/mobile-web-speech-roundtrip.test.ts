import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import { webVoiceSettingsOperations } from '../settings/web-voice-settings-operations'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'
import type { RpcClient } from '../transport/rpc-client'
import {
  createMobileWebBrokerFixture,
  createMobileWebBridgeRoundtripFixture,
  mobileWebBridgeCancelMessage,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'

describe('mobile web speech broker', () => {
  it('loads host-authored setup through the generic catalog without losing future fields', async () => {
    const result = { ...setup(), futureModelPolicy: { mode: 'desktop-defined' } }
    const { operations, sendRequest, pageMessages } = createHostHarness(result)

    await expect(operations.load()).resolves.toEqual(result)
    expect(sendRequest).toHaveBeenNthCalledWith(
      1,
      'mobileWeb.host.catalog',
      { methods: ['speech.models.list'] },
      expect.objectContaining({ budgetSpansConnect: true })
    )
    expect(sendRequest).toHaveBeenNthCalledWith(
      2,
      'speech.models.list',
      {},
      expect.objectContaining({ beforeSend: expect.any(Function), budgetSpansConnect: true })
    )
    expect(pageMessages).toEqual([
      expect.objectContaining({
        capability: 'workspace',
        operation: 'hostRequest',
        payload: { method: 'speech.models.list', params: {} }
      })
    ])
  })

  it('rejects setup metadata exceeding the advertised host response budget', async () => {
    const { operations } = createHostHarness({ ...setup(), future: 'x'.repeat(64 * 1024) })
    await expect(operations.load()).rejects.toMatchObject({ code: 'too_large' })
  })

  it('does not dispatch setup when Desktop omits its grant', async () => {
    const { operations, sendRequest } = createHostHarness(setup(), false)
    await expect(operations.load()).rejects.toMatchObject({ code: 'unsupported_capability' })
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('accounts for the single speech subscription and releases it on cancel', async () => {
    const harness = createHarness()
    await harness.broker.handle(request('A', 'subscription', 'subscribe', {}, 'Q'))
    await harness.broker.handle(request('B', 'subscription', 'subscribe', {}, 'R'))
    expect(harness.messages.at(-1)).toMatchObject({
      status: 'error',
      error: { code: 'rate_limited' }
    })

    await harness.broker.handle(cancel('Q'))
    await harness.broker.handle(request('C', 'subscription', 'subscribe', {}, 'T'))

    expect(harness.messages.at(-1)).toMatchObject({
      status: 'success',
      payload: null
    })
  })

  it('rejects a speech payload the operation contract does not accept', async () => {
    const harness = createHarness()

    await harness.broker.handle(request('A', 'once', 'start', { unexpected: true }))

    expect(harness.messages.at(-1)).toMatchObject({ status: 'error' })
    expect(harness.sendRequest).not.toHaveBeenCalled()
  })
})

function createHostHarness(result: unknown, advertised = true) {
  const sendRequest = vi
    .fn<RpcClient['sendRequest']>()
    .mockResolvedValueOnce({
      ok: true,
      result: {
        grants: advertised
          ? [
              {
                method: 'speech.models.list',
                scope: 'host',
                maxRequestBytes: 4096,
                maxResponseBytes: 64 * 1024
              }
            ]
          : []
      }
    })
    .mockResolvedValueOnce({ ok: true, result })
  const { client, pageMessages } = createMobileWebBridgeRoundtripFixture({
    grants: MOBILE_WEB_PRODUCTION_GRANTS,
    rpcClient: { sendRequest } as unknown as RpcClient
  })
  return { operations: webVoiceSettingsOperations(client), sendRequest, pageMessages }
}

function createHarness() {
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client = { sendRequest } as unknown as RpcClient
  const { broker, messages } = createMobileWebBrokerFixture({
    getClient: () => client,
    navigationAuthority: {
      route: vi.fn(),
      reconnect: vi.fn(),
      removeHost: vi.fn()
    },
    now: () => 1000
  })
  return { broker, messages, sendRequest }
}

function request(
  id: string,
  mode: 'once' | 'subscription',
  operation: string,
  payload: unknown,
  subscriptionId = ''
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return mobileWebBridgeRequestMessage({
    requestId: id.repeat(22),
    capability: 'speech',
    operation,
    payload,
    ...(mode === 'subscription' ? { subscriptionId: subscriptionId.repeat(22) } : {})
  })
}

function cancel(id: string): Extract<MobileWebBridgePageMessage, { type: 'cancel' }> {
  return mobileWebBridgeCancelMessage({ target: 'subscription', id: id.repeat(22) })
}

function setup() {
  return {
    enabled: true,
    selectedModelId: 'model-1',
    dictationMode: 'toggle',
    models: [
      {
        id: 'model-1',
        label: 'Model One',
        provider: 'local',
        sizeBytes: 1024,
        recommended: true,
        status: 'ready',
        progress: null
      }
    ]
  }
}
