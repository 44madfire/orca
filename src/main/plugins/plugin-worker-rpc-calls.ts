import { z } from 'zod'
import {
  pluginWorkerInvokeRpcSchema,
  type PluginPanelRpcContext,
  type PluginWorkerParentMessage,
  type PluginWorkerRpcResult
} from '../../shared/plugins/plugin-host-protocol'
import {
  PluginWorkerRpcError,
  type PluginWorkerRpcFailureReason
} from './plugin-worker-rpc-failure'

export type PluginWorkerPendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type PendingRpc = PluginWorkerPendingCall

const pluginWorkerRpcJsonSchema = z.json()

/** Tracks in-flight worker-private RPC calls: timeouts, results, and exit cleanup. */
export class PluginWorkerRpcCalls {
  private readonly pending = new Map<number, PendingRpc>()
  private methods: readonly string[] = []
  private nextCallId = 0

  constructor(
    private readonly tag: string,
    private readonly invokeTimeoutMs: number,
    private readonly send: (message: PluginWorkerParentMessage) => void,
    private readonly onActivity: () => void
  ) {}

  setMethods(methods: readonly string[]): void {
    this.methods = methods
  }

  /** Handle-level pre-check rejection for calls made after the worker is gone. */
  rejectAfterExit(tag: string): Promise<never> {
    // Why worker_exit: after dispose the worker is shutting down, so from
    // the caller's view it is gone the same as after an exit event.
    return Promise.reject(
      new PluginWorkerRpcError('unavailable', `${tag} worker is not running`, 'worker_exit')
    )
  }

  invoke(method: string, params: unknown, context: PluginPanelRpcContext): Promise<unknown> {
    if (!this.methods.includes(method)) {
      return Promise.reject(
        new PluginWorkerRpcError('unknown_method', `${this.tag} unknown RPC method ${method}`)
      )
    }
    if (params !== undefined && !pluginWorkerRpcJsonSchema.safeParse(params).success) {
      return Promise.reject(
        new PluginWorkerRpcError(
          'invalid_request',
          `${this.tag} RPC params must be JSON-compatible`
        )
      )
    }
    const callId = this.nextCallId++
    // Why: validate before registering pending state, so a malformed
    // request rejects immediately instead of leaking a phantom in-flight
    // entry that lingers until the invoke timeout with a raw ZodError.
    const parsed = pluginWorkerInvokeRpcSchema.safeParse({
      type: 'invokeRpc',
      callId,
      method,
      ...(params === undefined ? {} : { params }),
      context
    })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const detail = issue
        ? `${issue.path.join('.') || '(root)'}: ${issue.message}`
        : 'invalid RPC request'
      return Promise.reject(
        new PluginWorkerRpcError(
          'invalid_request',
          `${this.tag} invalid RPC request: ${detail}`.slice(0, 512)
        )
      )
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId)
        reject(
          new PluginWorkerRpcError(
            'unavailable',
            `${this.tag} ${method} timed out after ${this.invokeTimeoutMs}ms`,
            'timeout'
          )
        )
      }, this.invokeTimeoutMs)
      this.pending.set(callId, { resolve, reject, timer })
      this.send(parsed.data)
    })
  }

  handleResult(message: PluginWorkerRpcResult): boolean {
    const entry = this.pending.get(message.callId)
    if (!entry) {
      return false
    }
    clearTimeout(entry.timer)
    this.pending.delete(message.callId)
    this.onActivity()
    if (message.ok) {
      entry.resolve(message.value)
    } else {
      // Why action_failed for every ok:false: the wire carries only an
      // error string, so any worker-side refusal (throw, non-JSON value,
      // oversized result) is attributed to the handler. Transport and
      // lifecycle faults never flow through here — they reject via
      // rejectAll as unavailable — so no text sniffing is needed.
      entry.reject(new PluginWorkerRpcError('action_failed', message.error))
    }
    return true
  }

  /** Rejects in-flight calls as unavailable; the lifecycle detail rides in
   *  `reason` for logs only, never for control flow. */
  rejectAll(message: string, reason: PluginWorkerRpcFailureReason): void {
    for (const [callId, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(callId)
      entry.reject(new PluginWorkerRpcError('unavailable', message, reason))
    }
  }

  inFlightCount(): number {
    return this.pending.size
  }
}
