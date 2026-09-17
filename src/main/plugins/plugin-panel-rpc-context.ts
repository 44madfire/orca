import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginPanelRpcContext } from '../../shared/plugins/plugin-host-protocol'

/** Host-owned worktree snapshot input for trusted RPC context. Verbatim
 *  strings from PluginRuntimeDelegate.resolveActiveWorktreeContext(). */
export type PanelRpcWorktreeSnapshot = {
  worktreeId: string
  path: string
  branch: string
  displayName: string
} | null

/**
 * ORPC-3 trusted per-request context. Filters the host snapshot by the
 * v1 capability rule: workspace:read present -> snapshot (copied by value);
 * absent -> null. Never normalizes the path string; the plugin interprets it.
 */
export function buildTrustedPanelRpcContext(
  panelId: string,
  grantedCapabilities: readonly PluginCapabilityKind[],
  snapshot: PanelRpcWorktreeSnapshot
): PluginPanelRpcContext {
  const grants = [...grantedCapabilities]
  const hasWorkspaceRead = grants.includes('workspace:read')
  if (!hasWorkspaceRead || !snapshot) {
    return { panelId, worktree: null, grantedCapabilities: grants }
  }
  // Why: copy by value so later delegate/focus changes cannot mutate an
  // admitted invocation's immutable snapshot.
  return {
    panelId,
    worktree: {
      worktreeId: snapshot.worktreeId,
      path: snapshot.path,
      branch: snapshot.branch,
      displayName: snapshot.displayName
    },
    grantedCapabilities: grants
  }
}
