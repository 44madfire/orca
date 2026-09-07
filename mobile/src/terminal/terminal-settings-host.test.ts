import { describe, expect, it, vi } from 'vitest'
import { nativeTerminalSettingsHost } from './native-terminal-settings-host'
import {
  webTerminalSettingsHost,
  webTerminalSettingsOperations
} from './web-terminal-settings-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null }
}))

describe('terminal restore settings adapters', () => {
  it('shares the single native accessory-read slot across settings sections', async () => {
    const client = {
      native: {
        supports: () => true,
        terminalAccessoryPreferences: vi
          .fn()
          .mockResolvedValue({
            customKeys: [],
            orderedBuiltInIds: ['escape'],
            visibleBuiltInIds: []
          })
      }
    }
    const settings = webTerminalSettingsOperations(client as unknown as MobileWebBridgeClient)
    await Promise.all([settings.loadKeys(), settings.loadLayout()])
    expect(client.native.terminalAccessoryPreferences).toHaveBeenCalledTimes(1)
  })

  it('unwraps the actual native RPC result and surfaces refusal', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ ok: true, result: { ms: 60000 } })
    const host = nativeTerminalSettingsHost({ id: 'host', name: 'Desktop' }, {
      sendRequest
    } as unknown as RpcClient)
    expect(await host.loadFit()).toBe(60000)
    sendRequest.mockResolvedValue({ ok: true, result: { ms: null } })
    expect(await host.saveFit(null)).toBe(null)
    sendRequest.mockResolvedValue({ ok: false, error: { message: 'denied' } })
    await expect(host.saveFit(60000)).rejects.toThrow('denied')
    expect(sendRequest).toHaveBeenLastCalledWith('terminal.setAutoRestoreFit', { ms: 60000 })
  })
  it('negotiates both host methods and sends no invented workspace', async () => {
    const client = fixture()
    const host = await webTerminalSettingsHost(client as unknown as MobileWebBridgeClient)
    expect(await host?.loadFit()).toBe(60000)
    expect(client.host.request).toHaveBeenCalledWith({
      method: 'terminal.getAutoRestoreFit',
      params: {}
    })
    await host?.saveFit(null)
    expect(client.host.request).toHaveBeenLastCalledWith({
      method: 'terminal.setAutoRestoreFit',
      params: { ms: null }
    })
  })
  it('does not dispatch when the shell or catalog lacks host-scoped methods', async () => {
    const client = fixture()
    client.supportsShellFeature.mockReturnValue(false)
    expect(await webTerminalSettingsHost(client as unknown as MobileWebBridgeClient)).toBe(null)
    expect(client.host.catalog).not.toHaveBeenCalled()
    client.supportsShellFeature.mockReturnValue(true)
    client.host.catalog.mockResolvedValue({ grants: [] })
    expect(await webTerminalSettingsHost(client as unknown as MobileWebBridgeClient)).toBe(null)
    expect(client.host.request).not.toHaveBeenCalled()
  })
  it('does not retry an ambiguous host mutation', async () => {
    const client = fixture()
    const host = await webTerminalSettingsHost(client as unknown as MobileWebBridgeClient)
    client.host.request.mockRejectedValue(new Error('connection lost'))
    await expect(host?.saveFit(60000)).rejects.toThrow('connection lost')
    expect(client.host.request).toHaveBeenCalledTimes(1)
  })
})
function fixture() {
  return {
    supportsShellFeature: vi.fn(() => true),
    host: {
      catalog: vi.fn().mockResolvedValue({
        grants: ['terminal.getAutoRestoreFit', 'terminal.setAutoRestoreFit'].map((method) => ({
          method,
          scope: 'host'
        }))
      }),
      request: vi.fn().mockResolvedValue({ ms: 60000 })
    }
  }
}
