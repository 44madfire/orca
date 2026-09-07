import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { saveTerminalTextScale } from '../storage/preferences'
import { saveCustomKeys } from '../storage/terminal-custom-key-storage'
import {
  loadWebHostTerminalPreferences,
  loadWebHostTerminalAccessoryPreferences
} from '../terminal/web-terminal-preferences'
export { loadWebHostTerminalPreferences } from '../terminal/web-terminal-preferences'
import type { HostSessionDeviceOperations } from './host-session-device-operations'

export function webHostSessionDeviceOperations(
  client: MobileWebBridgeClient,
  navigate?: (target: string) => void
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
      if (navigate && client.native.supports('pagePreferences')) {
        navigate('/terminal-settings')
      } else {
        void client.navigationRoute({ destination: 'terminalSettings' }).catch(() => {})
      }
    },
    loadTerminalPreferences() {
      return loadWebHostTerminalPreferences(client)
    },
    loadTerminalAccessoryPreferences() {
      return loadWebHostTerminalAccessoryPreferences(client)
    },
    async saveTerminalCustomKeys(customKeys) {
      if (client.native.supports('pagePreferences')) {
        await saveCustomKeys([...customKeys])
      } else {
        await client.native.terminalCustomKeysUpdate(customKeys)
      }
    },
    async saveTerminalTextScale(textScale) {
      if (client.native.supports('pagePreferences')) {
        await saveTerminalTextScale(textScale)
      } else {
        await client.native.terminalTextScaleUpdate(textScale)
      }
    }
  }
}
