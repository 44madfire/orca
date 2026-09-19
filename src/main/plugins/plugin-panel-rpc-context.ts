import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginPanelRpcContext } from '../../shared/plugins/plugin-host-protocol'

/**
 * ORPC-2 minimal panel RPC context. Only host-derived identity is attached:
 * the panelId comes from the resolved panel session and worktree stays null.
 * Granted capabilities pass through from the plugin's current approval
 * grants when trivially available. ORPC-3 replaces this seam with trusted
 * per-request worktree snapshots and consent-race hardening.
 */
export function buildPanelRpcContext(
  panelId: string,
  grantedCapabilities: readonly PluginCapabilityKind[]
): PluginPanelRpcContext {
  return {
    panelId,
    worktree: null,
    grantedCapabilities: [...grantedCapabilities]
  }
}
