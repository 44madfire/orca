import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginPanelRpcOutcome } from '../../shared/plugins/plugin-panel-bridge'
import { assertPluginWorkerCommand } from './plugin-command-invocation'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerHandle } from './plugin-host-process'
import type { PluginWorkerController } from './plugin-worker-controller'
import { buildPanelRpcContext } from './plugin-panel-rpc-context'

/**
 * Narrow host surface for plugin worker-invocation entries (worker commands
 * and session-bound panel RPC). Structural so PluginService passes `this`
 * directly, mirroring GrantedScopesResolver.
 */
export type PluginWorkerInvocationHost = {
  findValidPlugin(pluginKey: string): ValidDiscoveredPlugin | null
  isRuntimeApproved(plugin: ValidDiscoveredPlugin): boolean
  getGrantedCapabilities(pluginKey: string): PluginCapabilityKind[] | null
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

/** Session-bound panel→own-worker RPC. Context stays minimal (ORPC-2); the
 *  builder seam is owned by ORPC-3 for trusted worktree snapshots. */
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
  const grantedCapabilities = host.getGrantedCapabilities(pluginKey) ?? []
  let handle: PluginWorkerHandle
  try {
    handle = await host.workerController.ensure(plugin)
  } catch {
    return {
      ok: false,
      code: 'unavailable',
      error: `plugin ${pluginKey} worker is not available`
    }
  }
  if (!handle.rpcMethods.includes(method)) {
    return { ok: false, code: 'unknown_method', error: `unknown RPC method ${method}` }
  }
  try {
    const value = await handle.invokeRpc(
      method,
      params,
      buildPanelRpcContext(panelId, grantedCapabilities)
    )
    return { ok: true, value }
  } catch (error) {
    return mapPanelRpcInvocationError(error)
  }
}

/** Maps worker invocation rejections to the bounded panel RPC error model.
 *  The pre-dispatch method-presence check owns unknown_method; anything the
 *  worker fork reports afterwards is transport/lifecycle or handler failure. */
function mapPanelRpcInvocationError(error: unknown): PluginPanelRpcOutcome {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2048)
  if (message.includes('unknown RPC method')) {
    return { ok: false, code: 'unknown_method', error: message }
  }
  if (message.includes('JSON-compatible') || message.includes('invalid RPC request')) {
    return { ok: false, code: 'invalid_request', error: message }
  }
  if (
    message.includes('timed out') ||
    message.includes('not running') ||
    message.includes('exited') ||
    message.includes('disconnected') ||
    message.includes('crashed')
  ) {
    return { ok: false, code: 'unavailable', error: message }
  }
  return { ok: false, code: 'action_failed', error: message }
}
