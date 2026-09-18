import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'

/**
 * Internal failure provenance for worker-private RPC. The parent<->child
 * wire shape stays `{ ok: false, error: string }` — the kind never crosses
 * the fork. Every invokeRpc rejection is a PluginWorkerRpcError, so outcome
 * mappers branch on `kind`, never on message text.
 */
export type PluginWorkerRpcFailureKind =
  | 'handler_failure'
  | 'timeout'
  | 'worker_exit'
  | 'disconnect'
  | 'worker_crash'
  | 'invalid_request'
  | 'unknown_method'
  | 'worker_unavailable'

export class PluginWorkerRpcError extends Error {
  readonly kind: PluginWorkerRpcFailureKind

  constructor(kind: PluginWorkerRpcFailureKind, message: string) {
    super(message)
    this.name = 'PluginWorkerRpcError'
    this.kind = kind
  }
}

export function pluginWorkerRpcFailureKindOf(error: unknown): PluginWorkerRpcFailureKind | null {
  return error instanceof PluginWorkerRpcError ? error.kind : null
}

/** Panel outcome codes reachable from worker RPC. Shared subset of the host
 *  action and (ORPC-2) panel-RPC outcome shapes, so both mappers reuse it. */
export type PluginWorkerRpcOutcomeCode =
  | 'action_failed'
  | 'unavailable'
  | 'unknown_method'
  | 'invalid_request'

/** Kind-only code mapping. No message inspection: a handler that throws
 *  "operation timed out" still maps to action_failed. */
export function pluginWorkerRpcOutcomeCodeForKind(
  kind: PluginWorkerRpcFailureKind
): PluginWorkerRpcOutcomeCode {
  switch (kind) {
    case 'unknown_method':
      return 'unknown_method'
    case 'invalid_request':
      return 'invalid_request'
    case 'handler_failure':
      return 'action_failed'
    case 'timeout':
    case 'worker_exit':
    case 'disconnect':
    case 'worker_crash':
    case 'worker_unavailable':
      return 'unavailable'
  }
}

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

/** Tags worker spawn/ensure failures (thrown outside invokeRpc) so the
 *  outcome mapper reaches unavailable via the typed kind, not text. */
export function wrapPluginWorkerStartupFailure(pluginKey: string): PluginWorkerRpcError {
  // Why static panel message: spawn failures can carry host paths; the cause
  // stays in the activation error log, not the panel outcome.
  return new PluginWorkerRpcError(
    'worker_unavailable',
    `plugin ${pluginKey} worker is not available`
  )
}
