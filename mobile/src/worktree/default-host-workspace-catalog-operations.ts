import type { RpcClient } from '../transport/rpc-client'
import type { HostWorkspaceCatalogOperations } from './host-workspace-catalog-operations'
import { nativeHostWorkspaceCatalogOperations } from './native-host-workspace-catalog-operations'

export function defaultHostWorkspaceCatalogOperations(
  client: RpcClient
): HostWorkspaceCatalogOperations {
  return nativeHostWorkspaceCatalogOperations(client)
}
