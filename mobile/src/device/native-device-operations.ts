import * as Clipboard from 'expo-clipboard'
import * as ExpoCrypto from 'expo-crypto'
import { router } from 'expo-router'
import { Linking, Platform } from 'react-native'
import {
  triggerEdgeBump,
  triggerError,
  triggerMediumImpact,
  triggerSelection,
  triggerSuccess
} from '../platform/haptics'
import type { DeviceOperations } from './device-operations'

export const nativeDeviceOperations: DeviceOperations = {
  hapticFeedback(kind) {
    if (kind === 'selection') {
      triggerSelection()
    } else if (kind === 'success') {
      triggerSuccess()
    } else if (kind === 'error') {
      triggerError()
    } else if (kind === 'edge-bump') {
      triggerEdgeBump()
    } else {
      triggerMediumImpact()
    }
  },
  async clipboardAvailability() {
    const [hasText, hasImage] = await Promise.all([
      Clipboard.hasStringAsync().catch(() => false),
      Clipboard.hasImageAsync().catch(() => false)
    ])
    return { hasText, hasImage }
  },
  async copyText(text) {
    await Clipboard.setStringAsync(text)
    return { confirmation: Platform.OS === 'ios' ? 'in-app' : 'system' }
  },
  async openExternalUrl(url) {
    await Linking.openURL(url)
  },
  openTerminalSettings() {
    router.push('/terminal-settings')
  },
  randomNonce() {
    return ExpoCrypto.randomUUID()
  }
}
