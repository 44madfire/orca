import type { RpcClient } from '../transport/rpc-client'
import type { HostAccountOperations } from './host-account-operations'
import { nativeHostAccountOperations } from './native-host-account-operations'

export function defaultHostAccountOperations(
  client: RpcClient,
  hostId: string
): HostAccountOperations {
  return nativeHostAccountOperations(client, hostId)
}
