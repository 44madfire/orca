import { z } from 'zod'
import {
  pluginWorkerInvokeRpcSchema,
  type PluginPanelRpcContext,
  type PluginWorkerParentMessage,
  type PluginWorkerRpcResult
} from '../../shared/plugins/plugin-host-protocol'

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

  invoke(method: string, params: unknown, context: PluginPanelRpcContext): Promise<unknown> {
    if (!this.methods.includes(method)) {
      return Promise.reject(new Error(`${this.tag} unknown RPC method ${method}`))
    }
    if (params !== undefined && !pluginWorkerRpcJsonSchema.safeParse(params).success) {
      return Promise.reject(new Error(`${this.tag} RPC params must be JSON-compatible`))
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
      return Promise.reject(new Error(`${this.tag} invalid RPC request: ${detail}`.slice(0, 512)))
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId)
        reject(new Error(`${this.tag} ${method} timed out after ${this.invokeTimeoutMs}ms`))
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
      entry.reject(new Error(message.error))
    }
    return true
  }

  rejectAll(reason: string): void {
    for (const [callId, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(callId)
      entry.reject(new Error(reason))
    }
  }

  inFlightCount(): number {
    return this.pending.size
  }
}
