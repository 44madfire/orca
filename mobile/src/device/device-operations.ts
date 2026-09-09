/** Device capabilities a screen reaches through its host binding instead of importing a native
 *  module directly, so the same screen runs against a non-native provider later. */
export type DeviceHapticKind = 'selection' | 'success' | 'error' | 'edge-bump' | 'medium-impact'

export type DeviceClipboardAvailability = {
  hasText: boolean
  hasImage: boolean
}

/** iOS shows its own paste banner; every other platform needs the app to confirm. */
export type DeviceClipboardWriteResult = {
  confirmation: 'in-app' | 'system'
}

export type DeviceOperations = {
  hapticFeedback(kind: DeviceHapticKind): void
  clipboardAvailability(): Promise<DeviceClipboardAvailability>
  copyText(text: string): Promise<DeviceClipboardWriteResult>
  openExternalUrl(url: string): Promise<void>
  openTerminalSettings(): void
  randomNonce(): string
}
