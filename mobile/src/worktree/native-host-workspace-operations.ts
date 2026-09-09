import type { RpcClient } from '../transport/rpc-client'
import type { HostWorkspaceOperations } from './host-workspace-operations'
import { nativeHostWorkspaceCatalogOperations } from './native-host-workspace-catalog-operations'
import { nativeHostWorkspaceCreationOperations } from './native-host-workspace-creation-operations'

export function nativeHostWorkspaceOperations(client: RpcClient): HostWorkspaceOperations {
  return {
    catalog: nativeHostWorkspaceCatalogOperations(client),
    creation: nativeHostWorkspaceCreationOperations(client)
  }
}
