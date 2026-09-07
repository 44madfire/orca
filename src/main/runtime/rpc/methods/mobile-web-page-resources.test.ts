import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import {
  registerMobileWebPageResource,
  openMobileWebPageResources,
  resolveMobileWebPageResource
} from './mobile-web-page-resources'

function fixture() {
  const cleanups: (() => void)[] = []
  const runtime = { registerSubscriptionCleanup: vi.fn((_id, cleanup) => cleanups.push(cleanup)) }
  const context = { runtime, connectionId: 'connection' } as unknown as RpcContext
  cleanups.push(openMobileWebPageResources(context, 'page'))
  return { context, cleanups }
}

describe('host-owned page resources', () => {
  it('keeps private identities off the page and scopes opaque handles to runtime, connection, page, workspace and kind', () => {
    const { context } = fixture()
    const resource = {
      kind: 'future',
      workspace: 'workspace',
      identity: '/private/session',
      value: { privatePath: '/private/session' }
    }
    const handle = registerMobileWebPageResource(context, 'page', resource)
    expect(handle).not.toContain('private')
    expect(registerMobileWebPageResource(context, 'page', resource)).toBe(handle)
    expect(resolveMobileWebPageResource(context, 'page', 'workspace', 'future', handle)).toEqual(
      resource.value
    )
    for (const [ctx, page, workspace, kind] of [
      [context, 'different', 'workspace', 'future'],
      [context, 'page', 'different', 'future'],
      [context, 'page', 'workspace', 'different'],
      [{ ...context, connectionId: 'different' }, 'page', 'workspace', 'future'],
      [fixture().context, 'page', 'workspace', 'future']
    ] as const) {
      expect(() => resolveMobileWebPageResource(ctx, page, workspace, kind, handle)).toThrow(
        'selector_not_found'
      )
    }
  })

  it('rejects handles after explicit namespace cleanup', () => {
    const { context, cleanups } = fixture()
    const handle = registerMobileWebPageResource(context, 'page', {
      kind: 'future',
      workspace: 'w',
      identity: 'i',
      value: 1
    })
    cleanups[0]()
    expect(() => resolveMobileWebPageResource(context, 'page', 'w', 'future', handle)).toThrow(
      'selector_not_found'
    )
  })

  it('bounds resources within a page', () => {
    const { context } = fixture()
    for (let index = 0; index < 512; index++) {
      registerMobileWebPageResource(context, 'page', {
        kind: 'future',
        workspace: 'w',
        identity: String(index),
        value: index
      })
    }
    expect(() =>
      registerMobileWebPageResource(context, 'page', {
        kind: 'future',
        workspace: 'w',
        identity: 'extra',
        value: null
      })
    ).toThrow('runtime_unavailable')
  })
})
