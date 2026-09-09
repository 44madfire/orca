import type { HostFileExplorerOperations } from './host-file-explorer-operations'
import type { HostFilePreviewOperations } from './host-file-preview-operations'

/** Everything the file screens ask a host for, grouped by concern so a screen takes one prop and
 *  a provider is built once. Each namespace keeps its own contract file. */
export type HostFileOperations = {
  explorer: HostFileExplorerOperations
  preview: HostFilePreviewOperations
}
