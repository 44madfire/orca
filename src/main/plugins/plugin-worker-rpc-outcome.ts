import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import {
  pluginWorkerRpcFailureKindOf,
  pluginWorkerRpcOutcomeCodeForKind
} from './plugin-worker-rpc-failure'

/** Public outcome mapping for invokeRpc rejections. Branches only on the
 *  typed kind. Untagged errors (worker spawn/ensure failures raised outside
 *  invokeRpc — tag them with wrapPluginWorkerStartupFailure) are
 *  startup/transport faults, hence unavailable. */
export function mapPluginWorkerRpcErrorToOutcome(error: unknown): PluginPanelActionOutcome {
  // Why 2048: matches the service.invoke action_failed bound and the panel
  // relay error cap — outcomes stay small no matter what the handler threw.
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2048)
  const kind = pluginWorkerRpcFailureKindOf(error)
  if (!kind) {
    return { ok: false, code: 'unavailable', error: message }
  }
  return { ok: false, code: pluginWorkerRpcOutcomeCodeForKind(kind), error: message }
}
