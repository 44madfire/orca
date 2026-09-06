import { afterEach, describe, expect, it, vi } from 'vitest'
import storage from './hosted-page-async-storage'
import { setMobileWebPagePreferencesClient } from '../../../src/mobile-web/src/mobile-web-page-preferences-channel'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
afterEach(() => setMobileWebPagePreferencesClient(null))
describe('hosted page preference adapter', () => {
  it('uses the bounded native namespace and preserves callback semantics', async () => {
    const pagePreferences = vi
      .fn()
      .mockResolvedValueOnce({ entries: [['setting', 'saved']] })
      .mockResolvedValueOnce({ updated: true })
    setMobileWebPagePreferencesClient({
      native: { pagePreferences }
    } as unknown as MobileWebBridgeClient)
    const callback = vi.fn()
    expect(await storage.getItem('setting', callback)).toBe('saved')
    expect(callback).toHaveBeenCalledWith(null, 'saved')
    await storage.setItem('setting', 'next')
    expect(pagePreferences.mock.calls).toEqual([
      [{ namespace: 'expo.preferences', action: 'read', keys: ['setting'] }],
      [{ namespace: 'expo.preferences', action: 'write', entries: [['setting', 'next']] }]
    ])
  })

  it('fails clearly on old shells rather than pretending writes persisted', async () => {
    const error = new Error('unsupported_capability')
    setMobileWebPagePreferencesClient({
      native: { pagePreferences: vi.fn().mockRejectedValue(error) }
    } as unknown as MobileWebBridgeClient)
    const callback = vi.fn()
    await expect(storage.setItem('setting', 'next', callback)).rejects.toBe(error)
    expect(callback).toHaveBeenCalledWith(error)
  })

  it('discards a response after document replacement', async () => {
    const pending = Promise.withResolvers<unknown>()
    setMobileWebPagePreferencesClient({
      native: { pagePreferences: () => pending.promise }
    } as unknown as MobileWebBridgeClient)
    const read = storage.getItem('setting')
    setMobileWebPagePreferencesClient(null)
    pending.resolve({ entries: [['setting', 'from-old-host']] })
    await expect(read).rejects.toMatchObject({ code: 'cancelled' })
  })
})
