import type { RpcClient } from '../transport/rpc-client'
import type { HostFileOperations } from './host-file-operations'
import { nativeHostFileExplorerOperations } from './native-host-file-explorer-operations'
import { nativeHostFilePreviewOperations } from './native-host-file-preview-operations'

export function nativeHostFileOperations(
  client: RpcClient,
  reconnect: () => Promise<void>
): HostFileOperations {
  return {
    explorer: nativeHostFileExplorerOperations(client, reconnect),
    preview: nativeHostFilePreviewOperations(client, reconnect)
  }
}
