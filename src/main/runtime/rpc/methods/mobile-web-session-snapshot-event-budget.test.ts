import { openMobileWebPageResources } from './mobile-web-page-resources'
/**
 * Two limits govern one snapshot. `MOBILE_WEB_SESSION_TAB_LIMIT` degrades: it slices to 200, keeps
 * the active tab, and reports `truncated`. `MOBILE_WEB_SESSION_EVENT_MAX_BYTES` used to kill the
 * subscription instead, and a browser tab at the schema maximum serializes to roughly 5 KB, so a
 * user with ~40 long-URL tabs crossed the byte cap long before the count cap and the page hung on
 * "Loading tabs" forever. The byte cap now degrades the same way.
 */
import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_SESSION_EVENT_MAX_BYTES } from '../../../../shared/mobile-web/bridge-operation-contract'
import { mobileWebSessionResources } from './mobile-web-session-resources'
import type { RpcContext } from '../core'
import { mobileWebSessionSnapshot } from './mobile-web-session-snapshot'

const HOST_WORKSPACE = 'workspace-1'
const PAGE_WORKSPACE = 'opaque-workspace'

function oversizeBrowserTabs(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'browser',
    id: `page-${index}`.padEnd(512, 'x'),
    browserPageId: `page-${index}`,
    title: `Tab ${index}`.padEnd(240, 'y'),
    url: `https://example.invalid/${index}/${'q'.repeat(4000)}`,
    isActive: index === 3,
    loading: false,
    canGoBack: true,
    canGoForward: false
  }))
}

function hostSnapshot(count: number) {
  return {
    worktree: HOST_WORKSPACE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 3,
    activeTabId: 'page-3',
    activeTabType: 'browser',
    tabs: oversizeBrowserTabs(count)
  }
}

function authorities() {
  const context = {
    runtime: { registerSubscriptionCleanup() {} },
    connectionId: 'connection'
  } as unknown as RpcContext
  openMobileWebPageResources(context, 'page')
  return mobileWebSessionResources(context, 'page')
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

describe('mobile web session snapshot event budget', () => {
  it('is reachable: 40 maximum-size browser tabs exceed the cap well under the tab limit', () => {
    expect(encodedByteLength(hostSnapshot(40).tabs)).toBeGreaterThan(
      MOBILE_WEB_SESSION_EVENT_MAX_BYTES
    )
  })

  it('trims to fit, keeps the active tab, and reports truncated', () => {
    const authority = authorities()
    const snapshot = mobileWebSessionSnapshot(
      hostSnapshot(40),
      HOST_WORKSPACE,
      PAGE_WORKSPACE,
      authority.browser,
      authority.nativeChat
    )

    expect(encodedByteLength(snapshot)).toBeLessThanOrEqual(MOBILE_WEB_SESSION_EVENT_MAX_BYTES)
    expect(snapshot.tabs.length).toBeGreaterThan(0)
    expect(snapshot.tabs.length).toBeLessThan(40)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.tabs.some((tab) => tab.isActive)).toBe(true)
    expect(snapshot.activeTabId).toBe(snapshot.tabs.find((tab) => tab.isActive)?.id)
  })

  it('leaves a snapshot that already fits untouched', () => {
    const authority = authorities()
    const snapshot = mobileWebSessionSnapshot(
      hostSnapshot(3),
      HOST_WORKSPACE,
      PAGE_WORKSPACE,
      authority.browser,
      authority.nativeChat
    )

    expect(snapshot.tabs).toHaveLength(3)
    expect(snapshot.truncated).toBe(false)
  })
})
