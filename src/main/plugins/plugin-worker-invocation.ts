import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginPanelRpcOutcome } from '../../shared/plugins/plugin-panel-bridge'
import { assertPluginWorkerCommand } from './plugin-command-invocation'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerHandle } from './plugin-host-process'
import type { PluginWorkerController } from './plugin-worker-controller'
import {
  buildTrustedPanelRpcContext,
  type PanelRpcWorktreeSnapshot
} from './plugin-panel-rpc-context'
import {
  pluginWorkerRpcFailureKindOf,
  pluginWorkerRpcOutcomeCodeForKind,
  wrapPluginWorkerStartupFailure
} from './plugin-worker-rpc-failure'

/**
 * Narrow host surface for plugin worker-invocation entries (worker commands
 * and session-bound panel RPC). Structural so PluginService passes `this`
 * directly, mirroring GrantedScopesResolver.
 */
export type PluginWorkerInvocationHost = {
  findValidPlugin(pluginKey: string): ValidDiscoveredPlugin | null
  isRuntimeApproved(plugin: ValidDiscoveredPlugin): boolean
  getGrantedCapabilities(pluginKey: string): PluginCapabilityKind[] | null
  /** Host-owned active-worktree snapshot; null/absent means no trusted scope. */
  resolveActiveWorktreeContext?: () => Promise<PanelRpcWorktreeSnapshot>
  workerController: Pick<PluginWorkerController, 'ensure'>
}

export async function invokePluginCommand(
  host: PluginWorkerInvocationHost,
  pluginKey: string,
  commandId: string,
  args?: unknown
): Promise<unknown> {
  const plugin = host.findValidPlugin(pluginKey)
  if (!plugin || !host.isRuntimeApproved(plugin)) {
    throw new Error(`plugin ${pluginKey} is not enabled`)
  }
  assertPluginWorkerCommand(plugin, commandId)
  const handle = await host.workerController.ensure(plugin)
  if (!handle.commands.includes(commandId)) {
    throw new Error(`plugin ${pluginKey} registered no handler for ${commandId}`)
  }
  return handle.invokeCommand(commandId, args)
}

/** Session-bound panel→own-worker RPC with trusted per-request context
 *  (ORPC-3). Order: approval -> fresh grants -> snapshot+filter (before any
 *  async worker dispatch) -> ensure -> invoke with the immutable snapshot. */
export async function invokePanelRpcForPlugin(
  host: PluginWorkerInvocationHost,
  pluginKey: string,
  panelId: string,
  method: string,
  params: unknown
): Promise<PluginPanelRpcOutcome> {
  const plugin = host.findValidPlugin(pluginKey)
  if (!plugin || !host.isRuntimeApproved(plugin)) {
    return { ok: false, code: 'unavailable', error: `plugin ${pluginKey} is not available` }
  }
  // Why: fresh per-request authority — a grant revoked after worker start
  // must hit the next call immediately; a null re-read fails closed instead
  // of dispatching with an empty grant set for a revoked plugin.
  const grantedCapabilities = host.getGrantedCapabilities(pluginKey)
  if (!grantedCapabilities) {
    return { ok: false, code: 'unavailable', error: `plugin ${pluginKey} is not available` }
  }
  // Why: snapshot before async dispatch so a focus switch during ensure/
  // invoke cannot retarget this admitted call. Skip the delegate without
  // workspace:read (filtered to null anyway); delegate absent -> null.
  let snapshot: PanelRpcWorktreeSnapshot = null
  if (
    grantedCapabilities.includes('workspace:read') &&
    host.resolveActiveWorktreeContext
  ) {
    try {
      snapshot = await host.resolveActiveWorktreeContext()
    } catch {
      return {
        ok: false,
        code: 'unavailable',
        error: `plugin ${pluginKey} worktree context is not available`
      }
    }
    if (!isWellFormedWorktreeSnapshot(snapshot)) {
      return {
        ok: false,
        code: 'unavailable',
        error: `plugin ${pluginKey} worktree context is not available`
      }
    }
  }
  // Why: immutable by value — the fork serializes a copy and later focus or
  // consent changes only affect the next request's fresh snapshot.
  const context = buildTrustedPanelRpcContext(panelId, grantedCapabilities, snapshot)
  let handle: PluginWorkerHandle
  try {
    handle = await host.workerController.ensure(plugin)
  } catch {
    const startupFailure = wrapPluginWorkerStartupFailure(pluginKey)
    return { ok: false, code: 'unavailable', error: startupFailure.message }
  }
  if (!handle.rpcMethods.includes(method)) {
    return { ok: false, code: 'unknown_method', error: `unknown RPC method ${method}` }
  }
  try {
    const value = await handle.invokeRpc(method, params, context)
    return { ok: true, value }
  } catch (error) {
    return mapPanelRpcInvocationError(error)
  }
}

/** Structural guard for delegate output; mirrors the fork-protocol maxima
 *  (worktreeId 1024 / path 4096 / branch+displayName 512) with no path
 *  normalization here. Oversized snapshots fail as bounded unavailable
 *  before worker ensure, not as invalid_request after dispatch. */
function isWellFormedWorktreeSnapshot(snapshot: PanelRpcWorktreeSnapshot): boolean {
  if (snapshot === null) {
    return true
  }
  return (
    typeof snapshot.worktreeId === 'string' &&
    snapshot.worktreeId.length >= 1 &&
    snapshot.worktreeId.length <= 1024 &&
    typeof snapshot.path === 'string' &&
    snapshot.path.length >= 1 &&
    snapshot.path.length <= 4096 &&
    typeof snapshot.branch === 'string' &&
    snapshot.branch.length <= 512 &&
    typeof snapshot.displayName === 'string' &&
    snapshot.displayName.length <= 512
  )
}

/** Maps invokeRpc rejections to the bounded panel RPC error model via the
 *  typed ORPC-1 failure kind. The pre-dispatch method-presence check owns
 *  unknown_method; anything the worker fork reports afterwards is transport/
 *  lifecycle or handler failure. Untagged errors are startup/transport
 *  faults, hence unavailable. */
function mapPanelRpcInvocationError(error: unknown): PluginPanelRpcOutcome {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2048)
  const kind = pluginWorkerRpcFailureKindOf(error)
  if (!kind) {
    return { ok: false, code: 'unavailable', error: message }
  }
  return { ok: false, code: pluginWorkerRpcOutcomeCodeForKind(kind), error: message }
}
