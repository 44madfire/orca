import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { MobileWebTerminalTextScale } from '../../../src/shared/mobile-web/native-operation-contract'
import {
  loadTerminalAutocompleteEnabled,
  loadTerminalTextScale,
  loadTerminalLinkOpenMode
} from '../storage/preferences'
import { loadCustomKeys } from '../storage/terminal-custom-key-storage'
import { loadTerminalAccessoryLayout } from './terminal-accessory-layout'

export async function loadWebHostTerminalPreferences(client: MobileWebBridgeClient) {
  const native = await client.native.terminalPreferences()
  // Settings sections mount together; keep their combined reads below the bridge grant.
  const textScale = await loadTerminalTextScale({
    fallback: native.textScale,
    rejectReadFailure: true
  })
  const autocompleteEnabled = await loadTerminalAutocompleteEnabled({
    fallback: native.autocompleteEnabled,
    rejectReadFailure: true
  })
  const linkOpenMode = await loadTerminalLinkOpenMode(native.linkOpenMode)
  return { textScale: textScale as MobileWebTerminalTextScale, autocompleteEnabled, linkOpenMode }
}
export async function loadWebHostTerminalAccessoryPreferences(client: MobileWebBridgeClient) {
  const native = await client.native.terminalAccessoryPreferences()
  const customKeys = await loadCustomKeys({ fallback: native.customKeys, rejectReadFailure: true })
  const layout = await loadTerminalAccessoryLayout({ fallback: native, rejectReadFailure: true })
  return {
    customKeys,
    orderedBuiltInIds: layout.orderedBuiltInIds,
    visibleBuiltInIds: layout.visibleBuiltInIds
  }
}
