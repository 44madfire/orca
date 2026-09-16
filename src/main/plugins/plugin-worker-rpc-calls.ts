import { z } from 'zod'
import {
  pluginWorkerInvokeRpcSchema,
  type PluginWorkerParentMessage
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

  getMethods(): readonly string[] {
    return this.methods
  }

  invoke(method: string, params?: unknown): Promise<unknown> {
    if (!this.methods.includes(method)) {
      return Promise.reject(new Error(`${this.tag} unknown RPC method ${method}`))
    }
    if (params !== undefined && !pluginWorkerRpcJsonSchema.safeParse(params).success) {
      return Promise.reject(new Error(`${this.tag} RPC params must be JSON-compatible`))
    }
    const callId = this.nextCallId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId)
        reject(new Error(`${this.tag} ${method} timed out after ${this.invokeTimeoutMs}ms`))
      }, this.invokeTimeoutMs)
      this.pending.set(callId, { resolve, reject, timer })
      // Why: params already JSON-validated; re-parse so the wire object
      // carries the schema's JSON type without an assertion.
      this.send(
        pluginWorkerInvokeRpcSchema.parse({
          type: 'invokeRpc',
          callId,
          method,
          ...(params === undefined ? {} : { params })
        })
      )
    })
  }

  handleResult(message: { callId: number; ok: boolean; value?: unknown; error?: string }): boolean {
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
      entry.reject(new Error(message.error ?? 'plugin RPC failed'))
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
