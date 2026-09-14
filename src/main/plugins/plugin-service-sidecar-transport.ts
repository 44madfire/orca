import { randomUUID } from 'node:crypto'
import { ServiceExecutionError, serviceExecutionError } from './plugin-service-execution-errors'

// Missing executables stay `service-unavailable`, distinct from start failure.
export function toStartError(error: unknown, serviceId: string): ServiceExecutionError {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return serviceExecutionError('service-unavailable', serviceId)
  }
  return error instanceof ServiceExecutionError
    ? error
    : serviceExecutionError('start-failed', serviceId, 'service failed to start')
}
import type { SpawnedProcess, spawnProcess } from '../../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'

// Host-owned launch description. Built entirely from the service
// registration + resolved worktree runtime; panel input never reaches here.
export type SidecarLaunch = {
  program: string
  args: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}
export type SidecarInvokeOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}
export type PluginServiceSidecarDeps = {
  spawnImpl?: typeof spawnProcess
  terminateImpl?: typeof forceTerminateProcessTree
  startupGraceMs?: number
  requestTimeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  maxLineBytes?: number
  // False once the owning host is torn down; guards against serving or
  // starting children from a disposed scope.
  isHostOpen?: () => boolean
}
export type SteadyChildHandlers = {
  owner: SpawnedProcess
  onError: (error: Error) => void
  onExit: () => void
}
export type PendingServiceRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
  settled: boolean
}

export function jsonBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value ?? null)
    return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : null
  } catch {
    return null
  }
}

// LF-only split; strips one trailing CR for CRLF tolerance.
export function splitFramedLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = []
  let start = 0
  for (;;) {
    const index = buffer.indexOf('\n', start)
    if (index === -1) {
      break
    }
    let line = buffer.slice(start, index)
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    lines.push(line)
    start = index + 1
  }
  return { lines, rest: buffer.slice(start) }
}

export type ParsedServiceRecord = { id: string; response: unknown }

// Throws a redacted malformed-response error; never returns host bytes.
export function parseServiceRecord(
  line: string,
  serviceId: string,
  maxResponseBytes: number
): ParsedServiceRecord {
  let record: { id?: unknown; response?: unknown; error?: unknown }
  try {
    record = JSON.parse(line) as { id?: unknown; response?: unknown }
  } catch {
    throw serviceExecutionError('malformed-response', serviceId, 'unreadable response')
  }
  if (typeof record.id !== 'string') {
    throw serviceExecutionError('malformed-response', serviceId, 'unreadable response')
  }
  if (record.error !== undefined) {
    throw serviceExecutionError('crashed', serviceId, 'service failed')
  }
  const bytes = jsonBytes(record.response ?? null)
  if (bytes === null || bytes > maxResponseBytes) {
    throw serviceExecutionError('malformed-response', serviceId, 'unreadable response')
  }
  return { id: record.id, response: record.response ?? null }
}

// Pending-request registry behind one sidecar. Timeout detaches only the
// timed-out caller; cancellation keeps the child alive for siblings.
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

// Correlated JSONL write behind one sidecar; concurrent callers never see
// each other's payloads. Rejects locally on validation/write failure.
export function sendSidecarRequest(
  target: SidecarRequestSendTarget,
  request: unknown,
  options: SidecarInvokeOptions & {
    onTimeout: (id: string) => void
    onCancel: (id: string) => void
  }
): Promise<unknown> {
  if (!target.child || target.dead) {
    return Promise.reject(serviceExecutionError('crashed', target.serviceId, 'service exited'))
  }
  const child = target.child
  const id = randomUUID()
  const line = `${JSON.stringify({ id, request })}\n`
  const timeoutMs = options.timeoutMs ?? target.deps.requestTimeoutMs ?? 30_000
  return new Promise<unknown>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(serviceExecutionError('cancelled', target.serviceId, 'request was cancelled'))
      return
    }
    try {
      target.pending.add({
        id,
        resolve,
        reject,
        timeoutMs,
        signal: options.signal,
        onTimeout: options.onTimeout,
        onCancel: options.onCancel
      })
    } catch (error) {
      reject(
        error instanceof ServiceExecutionError
          ? error
          : serviceExecutionError('cancelled', target.serviceId, 'request was cancelled')
      )
      return
    }
    try {
      child.stdin?.write(line)
    } catch (error) {
      target.pending.take(id)
      reject(
        error instanceof ServiceExecutionError
          ? error
          : serviceExecutionError('crashed', target.serviceId, 'service exited')
      )
    }
  })
}

// Best-effort tree kill so WSL/Windows descendants die with the root.
// True only when termination verified; callers propagate a false return so
// teardown retries instead of forgetting a possibly-live tree.
export async function terminateSidecarChild(
  child: SpawnedProcess,
  terminateImpl?: typeof forceTerminateProcessTree
): Promise<boolean> {
  const terminate = terminateImpl ?? forceTerminateProcessTree
  const verified = await terminate(child).catch(() => false)
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  try {
    child.stdout?.destroy()
  } catch {
    /* ignore */
  }
  try {
    child.stderr?.destroy()
  } catch {
    /* ignore */
  }
  return verified
}
