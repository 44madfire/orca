import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { loadTerminalLinkOpenMode } from '../storage/preferences'
import type { HostSessionDeviceOperations } from './host-session-device-operations'

export function webHostSessionDeviceOperations(
  client: MobileWebBridgeClient
): HostSessionDeviceOperations {
  return {
    hapticFeedback(kind) {
      void client.native.hapticFeedback(kind).catch(() => {})
    },
    clipboardAvailability() {
      return client.native.clipboardAvailability()
    },
    copyText(text) {
      return client.native.clipboardWrite(text)
    },
    async openExternalUrl(url) {
      await client.native.openExternal(url)
    },
    openTerminalSettings() {
      void client.navigationRoute({ destination: 'terminalSettings' }).catch(() => {})
    },
    loadTerminalPreferences() {
      return loadWebHostTerminalPreferences(client)
    },
    loadTerminalAccessoryPreferences() {
      return client.native.terminalAccessoryPreferences()
    },
    async saveTerminalCustomKeys(customKeys) {
      await client.native.terminalCustomKeysUpdate(customKeys)
    },
    async saveTerminalTextScale(textScale) {
      await client.native.terminalTextScaleUpdate(textScale)
    }
  }
}

export async function loadWebHostTerminalPreferences(client: MobileWebBridgeClient) {
  const preferences = await client.native.terminalPreferences()
  if (!client.native.supports('pagePreferences')) {
    return preferences
  }
  return {
    ...preferences,
    linkOpenMode: await loadTerminalLinkOpenMode(preferences.linkOpenMode)
  }
}
