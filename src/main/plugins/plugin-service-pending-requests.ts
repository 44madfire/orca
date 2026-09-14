import { ServiceExecutionError, serviceExecutionError } from './plugin-service-execution-errors'
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

// Bounded stdin write: resolves once the line is accepted, rejects when the
// stream errors, aborts, or stays unwritable past the request budget. Every
// listener is removed on settle so a hung child cannot accrue handlers.
export function writeSidecarLine(
  child: SpawnedProcess,
  line: string,
  input: { serviceId: string; timeoutMs: number; signal?: AbortSignal }
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stdin = child.stdin
    if (!stdin) {
      reject(serviceExecutionError('crashed', input.serviceId, 'service exited'))
      return
    }
    if (input.signal?.aborted) {
      reject(serviceExecutionError('cancelled', input.serviceId, 'request was cancelled'))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      finish(() => reject(serviceExecutionError('timeout', input.serviceId, 'service timed out')))
    }, input.timeoutMs)
    timer.unref?.()
    const finish = (settle: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      stdin.removeListener('drain', onDrain)
      stdin.removeListener('error', onError)
      settle()
    }
    const onAbort = (): void => {
      finish(() =>
        reject(serviceExecutionError('cancelled', input.serviceId, 'request was cancelled'))
      )
    }
    const onDrain = (): void => {
      finish(() => resolve())
    }
    const onError = (error: Error): void => {
      finish(() =>
        reject(
          error instanceof ServiceExecutionError
            ? error
            : serviceExecutionError('crashed', input.serviceId, 'service exited')
        )
      )
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    stdin.once('drain', onDrain)
    stdin.once('error', onError)
    let accepted: boolean
    try {
      accepted = stdin.write(line)
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error('service write failed')))
      return
    }
    if (accepted) {
      finish(() => resolve())
    }
  })
}
