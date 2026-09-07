import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS,
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage
} from '../../shared/mobile-web/bridge-contract'
import { readMobileWebHostCatalog } from './mobile-web-host-catalog-queue'
import { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

const context = {
  version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
} as const
const clients: MobileWebOneShotRequestClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.dispose()
  }
  vi.useRealTimers()
})

function fixture(requestTimeoutMs = 1000) {
  const messages: MobileWebBridgePageMessage[] = []
  const client = new MobileWebOneShotRequestClient({
    getGrant: () => ({
      capability: 'workspace',
      operation: 'hostCatalog',
      limits: {
        maxConcurrent: 2,
        maxRequestBytes: 16384,
        maxResponseBytes: 524288,
        rateCapacity: 8,
        rateRefillPerSecond: 2
      }
    }),
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    envelope: () => context,
    createRequestId: () => String(messages.length + 1).padStart(22, '0'),
    otherPendingCount: () => 0,
    requestTimeoutMs
  })
  clients.push(client)
  const requests = () => messages.filter((message) => message.type === 'request')
  return {
    client,
    messages,
    requests,
    read: (methods: string[], options?: Parameters<typeof readMobileWebHostCatalog>[2]) =>
      readMobileWebHostCatalog(client, methods, options),
    respond: (index = 0) => {
      const request = requests()[index]!
      const { methods } = request.payload as { methods: string[] }
      client.receive({
        ...context,
        type: 'response',
        requestId: request.requestId,
        status: 'success',
        payload: {
          grants: methods.map((method) => ({
            method,
            scope: 'host',
            maxRequestBytes: 100,
            maxResponseBytes: 100
          }))
        }
      })
    }
  }
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

describe('host catalog read batching', () => {
  it('coalesces sibling readers and filters grants without caching across reads or clients', async () => {
    const a = fixture()
    const b = fixture()
    const first = a.read(['mobile.a', 'mobile.b'])
    const second = a.read(['mobile.b', 'mobile.c'])
    const other = b.read(['mobile.a'])
    await flush()
    expect(a.requests()).toHaveLength(1)
    expect(a.requests()[0]!.payload).toEqual({ methods: ['mobile.a', 'mobile.b', 'mobile.c'] })
    expect(b.requests()).toHaveLength(1)
    a.respond()
    b.respond()
    expect((await first).grants.map((grant) => grant.method)).toEqual(['mobile.a', 'mobile.b'])
    expect((await second).grants.map((grant) => grant.method)).toEqual(['mobile.b', 'mobile.c'])
    await other
    const again = a.read(['mobile.a'])
    await flush()
    expect(a.requests()).toHaveLength(2)
    a.respond(1)
    await again
  })

  it('cancels one caller independently and cancels the bridge only after all readers leave', async () => {
    const f = fixture()
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = f.read(['mobile.a'], { signal: firstAbort.signal }).catch((error) => error.code)
    const second = f.read(['mobile.b'], { signal: secondAbort.signal }).catch((error) => error.code)
    await flush()
    firstAbort.abort()
    expect(await first).toBe('cancelled')
    expect(f.messages.filter((message) => message.type === 'cancel')).toHaveLength(0)
    secondAbort.abort()
    expect(await second).toBe('cancelled')
    expect(f.messages.filter((message) => message.type === 'cancel')).toHaveLength(1)
  })

  it('preserves deadlines measured from admission, including time queued behind another batch', async () => {
    vi.useFakeTimers()
    const f = fixture(40)
    const first = f.read(['mobile.a'], { timeoutMs: 100 })
    const short = f.read(['mobile.b']).catch((error) => error.code)
    await flush()
    const queued = f.read(['mobile.c'], { timeoutMs: 20 }).catch((error) => error.code)
    await vi.advanceTimersByTimeAsync(20)
    expect(await queued).toBe('timeout')
    await vi.advanceTimersByTimeAsync(20)
    expect(await short).toBe('timeout')
    expect(f.messages.filter((message) => message.type === 'cancel')).toHaveLength(0)
    f.respond()
    expect((await first).grants.map((grant) => grant.method)).toEqual(['mobile.a'])
    await flush()
    expect(f.requests()).toHaveLength(1)
  })

  it('bounds batches to 32 methods and total admitted readers to the bridge pending ceiling', async () => {
    const f = fixture()
    const full = Array.from({ length: 32 }, (_, index) => `mobile.method${index}`)
    const first = f.read(full)
    const pending = Array.from({ length: MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS - 1 }, () =>
      f.read(['mobile.other'])
    )
    await expect(f.read(['mobile.overflow'])).rejects.toMatchObject({ code: 'rate_limited' })
    await flush()
    expect(f.requests()).toHaveLength(1)
    f.respond()
    await first
    await flush()
    expect(f.requests()).toHaveLength(2)
    expect(f.requests()[1]!.payload).toEqual({ methods: ['mobile.other'] })
    f.respond(1)
    await Promise.all(pending)
  })

  it('rejects invalid and pre-cancelled reads without posting and drains disposal without retries', async () => {
    const f = fixture()
    await expect(f.read([])).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(f.read(['mobile.a'], { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'cancelled'
    })
    expect(f.messages).toEqual([])
    const first = f.read(['mobile.a']).catch((error) => error.code)
    await flush()
    const queued = f.read(['mobile.b']).catch((error) => error.code)
    f.client.dispose()
    expect(await first).toBe('cancelled')
    expect(await queued).toBe('cancelled')
    expect(f.requests()).toHaveLength(1)
  })
})
