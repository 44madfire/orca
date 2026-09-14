import { serviceExecutionError } from './plugin-service-execution-errors'
import type { SpawnedProcess } from '../../shared/child-process/run-process'
import type { PluginServiceSidecarDeps } from './plugin-service-sidecar-transport'

export type PendingServiceRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
  settled: boolean
}

// Pending-request registry: timeout detaches only the timed-out caller.
export class SidecarPendingRequests {
  readonly pending = new Map<string, PendingServiceRequest>()

  get size(): number {
    return this.pending.size
  }

  add(input: {
    id: string
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timeoutMs: number
    signal?: AbortSignal
    onTimeout: (id: string) => void
    onCancel: (id: string) => void
  }): void {
    if (input.signal?.aborted) {
      throw serviceExecutionError('cancelled', '<unknown>', 'request was cancelled')
    }
    const timer = setTimeout(() => input.onTimeout(input.id), input.timeoutMs)
    timer.unref?.()
    const entry: PendingServiceRequest = {
      resolve: input.resolve,
      reject: input.reject,
      timer,
      settled: false,
      signal: input.signal
    }
    entry.onAbort = () => input.onCancel(input.id)
    input.signal?.addEventListener('abort', entry.onAbort, { once: true })
    this.pending.set(input.id, entry)
  }

  take(id: string): PendingServiceRequest | null {
    const entry = this.pending.get(id)
    if (!entry || entry.settled) {
      return null
    }
    entry.settled = true
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.onAbort as () => void)
    return entry
  }

  failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.settled) {
        continue
      }
      entry.settled = true
      clearTimeout(entry.timer)
      entry.signal?.removeEventListener('abort', entry.onAbort as () => void)
      entry.reject(error)
    }
    this.pending.clear()
  }

  drainForClose(serviceId: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.signal?.removeEventListener('abort', entry.onAbort as () => void)
      entry.reject(serviceExecutionError('cancelled', serviceId, 'service is closing'))
    }
    this.pending.clear()
  }
}

export type SidecarRequestSendTarget = {
  serviceId: string
  child: SpawnedProcess | null
  dead: Error | null
  pending: SidecarPendingRequests
  deps: PluginServiceSidecarDeps
}
