import type { HostWorkspaceCatalogOperations } from './host-workspace-catalog-operations'
import type { HostWorkspaceCreationOperations } from './host-workspace-creation-operations'

/** Everything the workspace screens ask a host for, grouped by concern so a screen takes one prop
 *  and a provider is built once. Each namespace keeps its own contract file. */
export type HostWorkspaceOperations = {
  catalog: HostWorkspaceCatalogOperations
  creation: HostWorkspaceCreationOperations
}
