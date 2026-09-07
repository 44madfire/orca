import { describe, expect, it } from 'vitest'
import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'

describe('native browser resource bindings', () => {
  it('scopes host-minted resources to their workspace and clears them on replacement', () => {
    const authority = new MobileWebBrowserAuthority()
    authority.bind('resource_browser', { hostWorkspaceId: 'workspace', hostPageId: 'private-page' })
    expect(authority.hostPageId('workspace', 'resource_browser')).toBe('private-page')
    expect(() => authority.hostPageId('different', 'resource_browser')).toThrow('not_found')
    expect(() => authority.hostTabId('workspace', 'resource_missing')).toThrow('not_found')
    expect(authority.hostTabId('workspace', 'terminal-tab')).toBe('terminal-tab')
    authority.clear()
    expect(() => authority.hostPageId('workspace', 'resource_browser')).toThrow('not_found')
  })
})
