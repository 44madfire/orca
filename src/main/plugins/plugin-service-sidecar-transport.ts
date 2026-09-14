import { randomUUID } from 'node:crypto'
import { ServiceExecutionError, serviceExecutionError } from './plugin-service-execution-errors'
import type { SpawnedProcess, spawnProcess } from '../../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'
import { sweepCrashedServiceTree } from './plugin-service-crashed-tree-sweep'
import type { SidecarRequestSendTarget } from './plugin-service-pending-requests'
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
  // Crash-sweep override for the dead-root path (tests); production walks
  // the Windows process table for surviving descendants.
  sweepCrashedTreeImpl?: typeof sweepCrashedServiceTree
}
export type SteadyChildHandlers = {
  owner: SpawnedProcess
  onError: (error: Error) => void
  onExit: () => void
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

// Correlated JSONL write; concurrent callers never see each other's payloads.
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

// Retired children awaiting proven termination (registered pre-await); at most
// one kill attempt runs per victim so the recycled-PID check stays meaningful.
export class SidecarVictimTracker {
  constructor(
    private readonly terminateImpl?: typeof forceTerminateProcessTree,
    private readonly sweepImpl: typeof sweepCrashedServiceTree = sweepCrashedServiceTree
  ) {}

  private readonly victims = new Set<SpawnedProcess>()
  private readonly inFlight = new Map<SpawnedProcess, Promise<boolean>>()

  retire(victim: SpawnedProcess): Promise<boolean> {
    const running = this.inFlight.get(victim)
    if (running) {
      return running
    }
    this.victims.add(victim)
    const attempt = terminateSidecarChild(victim, this.terminateImpl, this.sweepImpl).then(
      (proven) => {
        if (proven) {
          this.victims.delete(victim)
        }
        if (this.inFlight.get(victim) === attempt) {
          this.inFlight.delete(victim)
        }
        return proven
      }
    )
    this.inFlight.set(victim, attempt)
    return attempt
  }

  async redrive(): Promise<boolean> {
    let verified = true
    // Deleting during Set iteration is safe; each victim is visited once.
    for (const victim of this.victims) {
      if (!(await this.drive(victim))) {
        verified = false
      }
    }
    return verified && this.victims.size === 0
  }

  private drive(victim: SpawnedProcess): Promise<boolean> {
    return this.inFlight.get(victim) ?? this.retire(victim)
  }
}

// Best-effort tree kill so WSL/Windows descendants die with the root.
// True only when termination verified; callers propagate a false return so
// teardown retries instead of forgetting a possibly-live tree. A root that
// already exited takes the crash sweep on Windows (explicit descendant pids,
// never a /T walk from a possibly-reused root); other hosts keep the group
// semantics of forceTerminateProcessTree.
export async function terminateSidecarChild(
  child: SpawnedProcess,
  terminateImpl?: typeof forceTerminateProcessTree,
  sweepImpl: typeof sweepCrashedServiceTree = sweepCrashedServiceTree
): Promise<boolean> {
  const dead = (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null
  const pid = typeof child.pid === 'number' ? child.pid : null
  let verified: boolean
  if (dead && pid !== null && process.platform === 'win32') {
    verified = await sweepImpl(pid).catch(() => false)
  } else {
    const terminate = terminateImpl ?? forceTerminateProcessTree
    verified = await terminate(child).catch(() => false)
  }
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
