import { nativeDeviceOperations } from '../device/native-device-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { HostFilePreviewOperations } from './host-file-preview-operations'
import {
  loadMobileFilePreview,
  saveMobileTerminalArtifactPreview
} from './mobile-file-preview-request'

export function nativeHostFilePreviewOperations(
  client: RpcClient,
  reconnect: () => Promise<void>
): HostFilePreviewOperations {
  return {
    load(source, options) {
      return loadMobileFilePreview(client, source, undefined, options)
    },
    saveTerminalArtifact(source, content, options) {
      return saveMobileTerminalArtifactPreview(client, source, content, options)
    },
    reconnect,
    openExternalUrl(url) {
      return nativeDeviceOperations.openExternalUrl(url)
    }
  }
}
