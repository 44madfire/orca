import type { RpcContext } from '../../../src/main/runtime/rpc/core'
import { MOBILE_WEB_PAGE_LIFETIME_METHODS } from '../../../src/main/runtime/rpc/methods/mobile-web-page-lifetime'
import { RpcClientStreamRegistry } from '../transport/rpc-client-stream-registry'
import type { RpcClient } from '../transport/rpc-client'

import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS } from '../../../src/shared/mobile-web/bridge-contract'
import {
  registerMobileWebPageResource,
  resolveMobileWebPageResource
} from '../../../src/main/runtime/rpc/methods/mobile-web-page-resources'
import {
  createMobileWebBrokerFixture,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'
import { MobileWebPageLifetime } from './mobile-web-page-lifetime'

const randomBytes = (length: number) => new Uint8Array(length)

describe('broker document resource lifetime', () => {
  it('replaces 160 real brokers with unchanged shell context without leaking namespaces or touching another document', async () => {
    const host = pageLifetimeFixture()
    const unrelated = new MobileWebPageLifetime(randomBytes)
    const unrelatedId = await unrelated.get(host.client)
    const unrelatedHandle = registerMobileWebPageResource(host.context(), unrelatedId, {
      kind: 'test',
      workspace: 'w',
      identity: 'other',
      value: 7
    })
    const documents = new Set<string>()
    for (let index = 0; index < 160; index++) {
      const f = createMobileWebBrokerFixture({ getClient: () => host.client })
      await f.broker.handle(
        mobileWebBridgeRequestMessage({
          requestId: 'request',
          capability: 'workspace',
          operation: 'hostRequest',
          payload: { method: 'future.resource', params: {} }
        })
      )
      const response = f.messages.find((message) => message.type === 'response')
      expect(response).toMatchObject({ status: 'success' })
      const { pageSession, resourceId } = (
        response as unknown as { payload: { pageSession: string; resourceId: string } }
      ).payload
      documents.add(pageSession)
      expect(host.cleanups.size).toBe(2)
      f.broker.dispose()
      expect(host.cleanups.size).toBe(1)
      expect(host.registry.size()).toBe(1)
      expect(() =>
        resolveMobileWebPageResource(host.context(), pageSession, 'w', 'test', resourceId)
      ).toThrow('selector_not_found')
      expect(() =>
        registerMobileWebPageResource(host.context(), pageSession, {
          kind: 'test',
          workspace: 'w',
          identity: 'late',
          value: 0
        })
      ).toThrow('selector_not_found')
    }
    expect(documents.size).toBe(160)
    expect(
      resolveMobileWebPageResource(host.context(), unrelatedId, 'w', 'test', unrelatedHandle)
    ).toBe(7)
    unrelated.dispose()
    expect(host.cleanups.size).toBe(0)
  })

  it('disposes before host readiness and lets the transport retire the late ready token', async () => {
    const host = pageLifetimeFixture()
    host.deferOpen()
    const lifetime = new MobileWebPageLifetime(randomBytes)
    const ready = lifetime.get(host.client)
    const rejected = expect(ready).rejects.toMatchObject({ code: 'cancelled' })
    lifetime.dispose()
    await rejected
    expect(host.registry.size()).toBe(1)
    host.pending[0]!()
    expect(host.registry.size()).toBe(0)
    expect(host.cleanups.size).toBe(0)
    const id = host.requests[0]!.params.pageSession!
    expect(() =>
      registerMobileWebPageResource(host.context(), id, {
        kind: 'test',
        workspace: 'w',
        identity: 'late',
        value: 0
      })
    ).toThrow('selector_not_found')
  })

  it('cancels an actual broker request while namespace setup is pending without dispatching the resource call', async () => {
    const host = pageLifetimeFixture()
    host.deferOpen()
    const f = createMobileWebBrokerFixture({ getClient: () => host.client })
    const pending = f.broker.handle(
      mobileWebBridgeRequestMessage({
        requestId: 'request',
        capability: 'workspace',
        operation: 'hostRequest',
        payload: { method: 'future.resource', params: {} }
      })
    )
    await vi.waitFor(() => expect(host.pending).toHaveLength(1))
    f.broker.dispose()
    host.pending[0]!()
    await pending
    expect(host.cleanups.size).toBe(0)
    expect(host.registry.size()).toBe(0)
    expect(host.requests.map((entry) => entry.method)).toEqual([
      'mobileWeb.page.subscribe',
      'mobileWeb.page.unsubscribe'
    ])
    expect(f.messages).toEqual([])
  })

  it('replays namespace before dependent feeds and retains every advertised page stream slot', async () => {
    const host = pageLifetimeFixture()
    const lifetime = new MobileWebPageLifetime(randomBytes)
    const pageSession = await lifetime.get(host.client)
    const stop = Array.from({ length: MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS }, () =>
      host.client.subscribe('future.feed', { pageSession }, () => {}, {
        serverUnsubscribeMethod: 'future.unsubscribe'
      })
    )
    expect(host.registry.size()).toBe(MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS + 1)
    const before = host.requests.length
    host.reconnect()
    expect(host.requests.slice(before).map((request) => request.method)).toEqual([
      'mobileWeb.page.subscribe',
      ...stop.map(() => 'future.feed')
    ])
    expect(host.cleanups.size).toBe(1)
    stop.forEach((unsubscribe) => unsubscribe())
    lifetime.dispose()
    expect(host.registry.size()).toBe(0)
    expect(host.cleanups.size).toBe(0)
  })
})

function pageLifetimeFixture() {
  const cleanups = new Map<string, () => void>()
  const runtime = {
    registerSubscriptionCleanup: (key: string, cleanup: () => void) => cleanups.set(key, cleanup),
    cleanupSubscription: (key: string) => {
      const cleanup = cleanups.get(key)
      cleanups.delete(key)
      cleanup?.()
    }
  }
  let context = { runtime, connectionId: 'connection' } as unknown as RpcContext
  const requests: { id: string; method: string; params: Record<string, string> }[] = []
  const pending: (() => void)[] = []
  let deferOpen = false
  let nextId = 0
  const [open, close] = MOBILE_WEB_PAGE_LIFETIME_METHODS
  const registry = new RpcClientStreamRegistry({
    deviceToken: 'device',
    nextId: () => String(++nextId),
    getState: () => 'connected',
    sendEncrypted: (value) => {
      const request = value as (typeof requests)[number]
      requests.push(request)
      const ctx = context
      if (request.method === open.name) {
        const run = () =>
          open.handler(open.params!.parse(request.params), ctx, (result: unknown) => {
            if (context === ctx) {
              registry.handleResponse({
                id: request.id,
                ok: true,
                streaming: true,
                result,
                _meta: { runtimeId: 'runtime' }
              })
            }
          })
        if (deferOpen) {
          pending.push(run)
        } else {
          run()
        }
      } else if (request.method === close.name) {
        close.handler(close.params!.parse(request.params), ctx)
      } else if (request.method === 'future.feed') {
        registerMobileWebPageResource(ctx, request.params.pageSession!, {
          kind: 'test',
          workspace: 'w',
          identity: 'feed',
          value: true
        })
        registry.handleResponse({
          id: request.id,
          ok: true,
          streaming: true,
          result: { type: 'ready', subscriptionId: request.id }
        })
      }
      return true
    }
  })
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method, params, options) => {
    options?.beforeSend?.()
    if (method === 'mobileWeb.host.catalog') {
      return {
        ok: true,
        result: {
          grants: [
            {
              method: 'future.resource',
              scope: 'host',
              pageSessionParam: 'pageSession',
              maxRequestBytes: 1024,
              maxResponseBytes: 1024
            }
          ]
        }
      }
    }
    const pageSession = (params as { pageSession: string }).pageSession
    return {
      ok: true,
      result: {
        pageSession,
        resourceId: registerMobileWebPageResource(context, pageSession, {
          kind: 'test',
          workspace: 'w',
          identity: 'resource',
          value: true
        })
      }
    }
  })
  const client = {
    subscribe: registry.subscribe.bind(registry),
    sendRequest
  } as unknown as RpcClient
  return {
    client,
    registry,
    cleanups,
    requests,
    pending,
    context: () => context,
    deferOpen: () => {
      deferOpen = true
    },
    reconnect: () => {
      registry.markForReplay()
      context = { ...context, connectionId: 'reconnected' }
      for (const key of Array.from(cleanups.keys())) {
        runtime.cleanupSubscription(key)
      }
      registry.replayAfterAuthentication()
    }
  }
}
