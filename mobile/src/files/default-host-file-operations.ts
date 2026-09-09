import type { RpcClient } from '../transport/rpc-client'
import type { HostFileOperations } from './host-file-operations'
import { nativeHostFileOperations } from './native-host-file-operations'

export function defaultHostFileOperations(
  client: RpcClient,
  reconnect: () => Promise<void>
): HostFileOperations {
  return nativeHostFileOperations(client, reconnect)
}
