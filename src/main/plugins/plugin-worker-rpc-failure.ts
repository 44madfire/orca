/**
 * Typed failure for worker-private RPC. The parent<->child wire shape stays
 * `{ ok: false, error: string }` — the kind never crosses the fork. Every
 * invokeRpc rejection is a PluginWorkerRpcError, so outcome mappers branch
 * on `kind`, never on message text. The lifecycle detail (timeout, exit,
 * disconnect, crash, startup) is preserved in `reason` for messages/logs
 * only — never for control flow.
 */
export type PluginWorkerRpcFailureKind =
  | 'action_failed'
  | 'invalid_request'
  | 'unknown_method'
  | 'unavailable'

/** Collapsed lifecycle detail behind `unavailable`. Log/detail only. */
export type PluginWorkerRpcFailureReason =
  | 'timeout'
  | 'worker_exit'
  | 'disconnect'
  | 'worker_crash'
  | 'worker_unavailable'

export class PluginWorkerRpcError extends Error {
  readonly kind: PluginWorkerRpcFailureKind
  readonly reason: PluginWorkerRpcFailureReason | null

  constructor(
    kind: PluginWorkerRpcFailureKind,
    message: string,
    reason: PluginWorkerRpcFailureReason | null = null
  ) {
    super(message)
    this.name = 'PluginWorkerRpcError'
    this.kind = kind
    this.reason = reason
  }
}

export function pluginWorkerRpcFailureKindOf(error: unknown): PluginWorkerRpcFailureKind | null {
  return error instanceof PluginWorkerRpcError ? error.kind : null
}

/** Panel outcome codes reachable from worker RPC. Same four values as the
 *  failure kind, so the mapping is the identity — kept as a named helper
 *  so (ORPC-2) panel-RPC mappers delegate here instead of switching. */
export type PluginWorkerRpcOutcomeCode = PluginWorkerRpcFailureKind

/** Kind-only code mapping. No message inspection: a handler that throws
 *  "operation timed out" still maps to action_failed. */
export function pluginWorkerRpcOutcomeCodeForKind(
  kind: PluginWorkerRpcFailureKind
): PluginWorkerRpcOutcomeCode {
  return kind
}

/** Tags worker spawn/ensure failures (thrown outside invokeRpc) so the
 *  outcome mapper reaches unavailable via the typed kind, not text. */
export function wrapPluginWorkerStartupFailure(pluginKey: string): PluginWorkerRpcError {
  // Why static panel message: spawn failures can carry host paths; the cause
  // stays in the activation error log, not the panel outcome.
  return new PluginWorkerRpcError(
    'unavailable',
    `plugin ${pluginKey} worker is not available`,
    'worker_unavailable'
  )
}
