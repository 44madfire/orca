import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { MOBILE_WEB_PAGE_LIFETIME_METHODS } from './mobile-web-page-lifetime'
import { registerMobileWebPageResource } from './mobile-web-page-resources'

const open = MOBILE_WEB_PAGE_LIFETIME_METHODS[0]!
const close = MOBILE_WEB_PAGE_LIFETIME_METHODS[1]!

describe('host document namespace ownership', () => {
  it('bounds truly live documents and reclaims only the subscribed namespace', async () => {
    const cleanups = new Map<string, () => void>()
    const context = {
      connectionId: 'connection',
      runtime: {
        registerSubscriptionCleanup: (key: string, cleanup: () => void) =>
          cleanups.set(key, cleanup),
        cleanupSubscription: (key: string) => {
          const cleanup = cleanups.get(key)
          cleanups.delete(key)
          cleanup?.()
        }
      }
    } as unknown as RpcContext
    const emit = vi.fn()
    for (let index = 0; index < 128; index++) {
      await open.handler(open.params!.parse({ pageSession: `page-${index}` }), context, emit)
    }
    await expect(
      open.handler(open.params!.parse({ pageSession: 'overflow' }), context, emit)
    ).rejects.toThrow('runtime_unavailable')
    close.handler(
      close.params!.parse({ subscriptionId: 'page-0' }),
      { ...context, connectionId: 'other' },
      emit
    )
    expect(cleanups.size).toBe(128)
    close.handler(close.params!.parse({ subscriptionId: 'page-0' }), context, emit)
    expect(cleanups.size).toBe(127)
    expect(() =>
      registerMobileWebPageResource(context, 'page-0', {
        kind: 'test',
        workspace: 'w',
        identity: 'late',
        value: null
      })
    ).toThrow('selector_not_found')
    await open.handler(open.params!.parse({ pageSession: 'replacement' }), context, emit)
    expect(cleanups.size).toBe(128)
    for (const key of Array.from(cleanups.keys())) {
      context.runtime.cleanupSubscription(key)
    }
  })

  it('cleans the namespace on abort and never opens an already cancelled subscription', async () => {
    const controller = new AbortController()
    let cleanup: (() => void) | undefined
    const context = {
      connectionId: 'connection',
      signal: controller.signal,
      runtime: {
        registerSubscriptionCleanup: vi.fn((_key, value) => {
          cleanup = value
        }),
        cleanupSubscription: vi.fn(() => cleanup?.())
      }
    } as unknown as RpcContext
    const emit = vi.fn()
    await open.handler(open.params!.parse({ pageSession: 'page' }), context, emit)
    controller.abort()
    expect(emit).toHaveBeenLastCalledWith({ type: 'end' })
    expect(() =>
      registerMobileWebPageResource(context, 'page', {
        kind: 'test',
        workspace: 'w',
        identity: 'late',
        value: null
      })
    ).toThrow('selector_not_found')
    await open.handler(open.params!.parse({ pageSession: 'cancelled' }), context, emit)
    expect(context.runtime.registerSubscriptionCleanup).toHaveBeenCalledOnce()
  })
})
