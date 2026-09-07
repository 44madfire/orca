import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostSessionDeviceOperations } from './web-host-session-device-operations'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn() }
}))

describe('web host session device operations', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset().mockResolvedValue(null)
  })

  it('applies the paired-host page preference to terminal link behavior', async () => {
    const client = bridgeClient()
    client.native.supports.mockReturnValue(true)
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('orca-browser')
    const operations = webHostSessionDeviceOperations(client as unknown as MobileWebBridgeClient)
    await expect(operations.loadTerminalPreferences()).resolves.toEqual({
      textScale: 1.25,
      autocompleteEnabled: true,
      linkOpenMode: 'orca-browser'
    })
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('orca:terminalLinkOpenMode')
  })

  it('inherits the existing device mode until the host preference is saved', async () => {
    const client = bridgeClient()
    client.native.supports.mockReturnValue(true)
    const operations = webHostSessionDeviceOperations(client as unknown as MobileWebBridgeClient)
    expect((await operations.loadTerminalPreferences()).linkOpenMode).toBe('phone-browser')
    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('temporarily unavailable'))
    expect((await operations.loadTerminalPreferences()).linkOpenMode).toBe('phone-browser')
  })

  it('retains the native preference on shells without page storage', async () => {
    const client = bridgeClient()
    const operations = webHostSessionDeviceOperations(client as unknown as MobileWebBridgeClient)
    expect((await operations.loadTerminalPreferences()).linkOpenMode).toBe('phone-browser')
    expect(AsyncStorage.getItem).not.toHaveBeenCalled()
  })
  it('routes shell-owned effects through named native bridge methods', async () => {
    const client = bridgeClient()
    const operations = webHostSessionDeviceOperations(client as unknown as MobileWebBridgeClient)

    operations.hapticFeedback('selection')
    await expect(operations.clipboardAvailability()).resolves.toEqual({
      hasText: true,
      hasImage: false
    })
    await expect(operations.copyText('selected text')).resolves.toEqual({
      confirmation: 'in-app'
    })
    await operations.openExternalUrl('https://example.com')
    operations.openTerminalSettings()
    await expect(operations.loadTerminalPreferences()).resolves.toEqual({
      textScale: 1.25,
      autocompleteEnabled: true,
      linkOpenMode: 'phone-browser'
    })
    await expect(operations.loadTerminalAccessoryPreferences()).resolves.toEqual({
      customKeys: [],
      orderedBuiltInIds: ['escape', 'tab'],
      visibleBuiltInIds: ['escape']
    })
    await operations.saveTerminalCustomKeys([
      { id: 'custom-1', label: 'Build', bytes: 'pnpm build\r', enter: false }
    ])
    await operations.saveTerminalTextScale(1.5)

    expect(client.native.hapticFeedback).toHaveBeenCalledWith('selection')
    expect(client.native.clipboardAvailability).toHaveBeenCalledOnce()
    expect(client.native.clipboardWrite).toHaveBeenCalledWith('selected text')
    expect(client.native.openExternal).toHaveBeenCalledWith('https://example.com')
    expect(client.navigationRoute).toHaveBeenCalledWith({ destination: 'terminalSettings' })
    expect(client.native.terminalPreferences).toHaveBeenCalledOnce()
    expect(client.native.terminalAccessoryPreferences).toHaveBeenCalledOnce()
    expect(client.native.terminalCustomKeysUpdate).toHaveBeenCalledWith([
      { id: 'custom-1', label: 'Build', bytes: 'pnpm build\r', enter: false }
    ])
    expect(client.native.terminalTextScaleUpdate).toHaveBeenCalledWith(1.5)
  })

  it('keeps nonessential haptic failures out of the interaction path', () => {
    const client = bridgeClient()
    client.native.hapticFeedback.mockRejectedValue(new Error('unavailable'))
    const operations = webHostSessionDeviceOperations(client as unknown as MobileWebBridgeClient)

    expect(() => operations.hapticFeedback('selection')).not.toThrow()
  })
})

function bridgeClient() {
  return {
    navigationRoute: vi.fn().mockResolvedValue(null),
    native: {
      supports: vi.fn().mockReturnValue(false),
      hapticFeedback: vi.fn().mockResolvedValue(null),
      clipboardAvailability: vi.fn().mockResolvedValue({ hasText: true, hasImage: false }),
      clipboardWrite: vi.fn().mockResolvedValue({ confirmation: 'in-app' }),
      openExternal: vi.fn().mockResolvedValue(null),
      terminalPreferences: vi.fn().mockResolvedValue({
        textScale: 1.25,
        autocompleteEnabled: true,
        linkOpenMode: 'phone-browser'
      }),
      terminalAccessoryPreferences: vi.fn().mockResolvedValue({
        customKeys: [],
        orderedBuiltInIds: ['escape', 'tab'],
        visibleBuiltInIds: ['escape']
      }),
      terminalCustomKeysUpdate: vi.fn().mockResolvedValue(null),
      terminalTextScaleUpdate: vi.fn().mockResolvedValue(null)
    }
  }
}
