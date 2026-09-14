import { randomUUID } from 'node:crypto'
import { ServiceExecutionError, serviceExecutionError } from './plugin-service-execution-errors'
import type { SpawnedProcess, spawnProcess } from '../../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'
import { sweepCrashedServiceTree } from './plugin-service-crashed-tree-sweep'
import type { WslGuestHandle } from './plugin-service-wsl-guest'
import { writeSidecarLine, type SidecarRequestSendTarget } from './plugin-service-pending-requests'
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
  // In-flight request cap; excess callers fail fast as overloaded.
  maxPendingRequests?: number
  // False once the owning host is torn down; guards against serving or
  // starting children from a disposed scope.
  isHostOpen?: () => boolean
  // Crash-sweep override for the dead-root path (tests); production walks
  // the Windows process table for surviving descendants.
  sweepCrashedTreeImpl?: typeof sweepCrashedServiceTree
  // Guest-side owner for WSL sidecars; wrapper-only hosts leave this empty.
  wslGuest?: WslGuestHandle | null
  // Root-identity capture override (tests); production reads the table.
  readRootCreationTime?: (pid: number | undefined) => Promise<number | null>
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
export const DEFAULT_SIDECAR_MAX_PENDING_REQUESTS = 64

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
  const maxPending = target.deps.maxPendingRequests ?? DEFAULT_SIDECAR_MAX_PENDING_REQUESTS
  return new Promise<unknown>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(serviceExecutionError('cancelled', target.serviceId, 'request was cancelled'))
      return
    }
    // In-flight cap: fail fast instead of queueing timers and writable bytes
    // behind a sidecar that stopped consuming them.
    if (target.pending.size >= maxPending) {
      reject(serviceExecutionError('overloaded', target.serviceId, 'service is overloaded'))
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
    // Backpressure-aware write: a stalled stdin fails this request instead of
    // buffering it forever. Response routing still owns request settlement.
    writeSidecarLine(child, line, {
      serviceId: target.serviceId,
      timeoutMs,
      signal: options.signal
    }).then(undefined, (error: unknown) => {
      const entry = target.pending.take(id)
      if (entry) {
        entry.reject(
          error instanceof ServiceExecutionError
            ? error
            : serviceExecutionError('crashed', target.serviceId, 'service exited')
        )
      }
    })
  })
}

// Retired children awaiting proven termination; at most one kill attempt
// runs per victim so the recycled-PID check stays meaningful.
export type TrackedVictim = {
  proc: SpawnedProcess
  creationTimeMs: number | null
  // Retirement stamp bounding legitimate births under dead parents.
  retiredAtMs: number
}

export class SidecarVictimTracker {
  constructor(
    private readonly terminateImpl?: typeof forceTerminateProcessTree,
    private readonly sweepImpl: typeof sweepCrashedServiceTree = sweepCrashedServiceTree,
    private readonly guest: WslGuestHandle | null = null
  ) {}

  private readonly victims = new Set<TrackedVictim>()
  private readonly inFlight = new Map<SpawnedProcess, Promise<boolean>>()

  retire(proc: SpawnedProcess, creationTimeMs: number | null): Promise<boolean> {
    const running = this.inFlight.get(proc)
    if (running) {
      return running
    }
    // One record per proc: re-retiring a tracked victim must reuse it,
    // otherwise redrive-while-tracked grows the set without bound.
    let victim: TrackedVictim | undefined
    for (const candidate of this.victims) {
      if (candidate.proc === proc) {
        victim = candidate
        break
      }
    }
    victim ??= { proc, creationTimeMs, retiredAtMs: Date.now() }
    if (victim.creationTimeMs == null) {
      victim.creationTimeMs = creationTimeMs
    }
    this.victims.add(victim)
    // Guest first would invite wslhost adoption of a live guest; the guest
    // dies first so the wrapper has nothing left to outlive, then the
    // wrapper is reaped. A reused record keeps its original retirement bound.
    const attempt = (async (): Promise<boolean> => {
      const guestOk = this.guest ? await this.guest.retire() : true
      const wrapperOk = await terminateSidecarChild(
        victim.proc,
        this.terminateImpl,
        this.sweepImpl,
        { creationTimeMs: victim.creationTimeMs, notAfterMs: victim.retiredAtMs }
      )
      return wrapperOk && guestOk
    })().then((proven) => {
      if (proven) {
        this.victims.delete(victim)
      }
      if (this.inFlight.get(victim.proc) === attempt) {
        this.inFlight.delete(victim.proc)
      }
      return proven
    })
    this.inFlight.set(victim.proc, attempt)
    return attempt
  }

  private drive(victim: TrackedVictim): Promise<boolean> {
    return this.inFlight.get(victim.proc) ?? this.retire(victim.proc, victim.creationTimeMs)
  }

  // Late identity upgrades a tracked victim for the next redrive.
  enrich(proc: SpawnedProcess, creationTimeMs: number | null): void {
    if (creationTimeMs == null) {
      return
    }
    for (const victim of this.victims) {
      if (victim.proc === proc && victim.creationTimeMs == null) {
        victim.creationTimeMs = creationTimeMs
        return
      }
    }
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
}

// Best-effort tree kill with verified teardown. A dead Windows root takes
// the crash sweep (explicit pids, never /T from a reused root); other hosts
// keep the group semantics of forceTerminateProcessTree.
export async function terminateSidecarChild(
  child: SpawnedProcess,
  terminateImpl?: typeof forceTerminateProcessTree,
  sweepImpl: typeof sweepCrashedServiceTree = sweepCrashedServiceTree,
  rootIdentity: { creationTimeMs: number | null; notAfterMs?: number | null } | null = null
): Promise<boolean> {
  const dead = (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null
  const pid = typeof child.pid === 'number' ? child.pid : null
  let verified: boolean
  if (dead && pid !== null && process.platform === 'win32') {
    verified = await sweepImpl({
      pid,
      creationTimeMs: rootIdentity?.creationTimeMs ?? null,
      notAfterMs: rootIdentity?.notAfterMs ?? null
    }).catch(() => false)
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
