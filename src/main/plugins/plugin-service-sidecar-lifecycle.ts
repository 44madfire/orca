import { StringDecoder } from 'node:string_decoder'
import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { ServiceExecutionError, serviceExecutionError } from './plugin-service-execution-errors'
import { startSidecarProcess } from './plugin-service-sidecar-startup'
import {
  SidecarPendingRequests,
  jsonBytes,
  parseServiceRecord,
  sendSidecarRequest,
  splitFramedLines,
  terminateSidecarChild,
  type PluginServiceSidecarDeps,
  type SidecarInvokeOptions,
  type SidecarLaunch,
  type SteadyChildHandlers
} from './plugin-service-sidecar-transport'

const DEFAULT_MAX_LINE_BYTES = 256 * 1024
// One long-lived child over bounded JSONL; requests correlate by id.
export class PluginServiceSidecar {
  private child: SpawnedProcess | null = null
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private readonly pending = new SidecarPendingRequests()
  private dead: Error | null = null
  private starting: Promise<void> | null = null
  private closed = false
  private shutdownVerified = true
  // Retired victims awaiting proven termination; close() re-drives them.
  private readonly unverified = new Set<SpawnedProcess>()
  private steady: SteadyChildHandlers | null = null
  private readonly onData = (chunk: Buffer | string): void => this.onStdout(chunk)
  private readonly onStderr = (): void => {}

  constructor(
    private readonly serviceId: string,
    private readonly launch: SidecarLaunch,
    private readonly deps: PluginServiceSidecarDeps = {}
  ) {}
  async invoke(request: unknown, options: SidecarInvokeOptions = {}): Promise<unknown> {
    if (this.closed) {
      throw serviceExecutionError('crashed', this.serviceId, 'service is closed')
    }
    const requestBytes = jsonBytes(request)
    if (requestBytes === null) {
      throw serviceExecutionError('malformed-response', this.serviceId, 'unserializable request')
    }
    const maxRequest = this.deps.maxRequestBytes ?? 64 * 1024
    if (requestBytes > maxRequest) {
      throw serviceExecutionError('malformed-response', this.serviceId, 'request is too large')
    }
    await this.ensureStarted()
    return this.sendRequest(request, options)
  }

  // True only when tree termination verified; false keeps the registry entry.
  // The victim is preserved across retries so every attempt re-drives termination.
  async close(): Promise<boolean> {
    this.closed = true
    this.pending.drainForClose(this.serviceId)
    const child = this.child
    this.child = null
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    let verified = true
    // Snapshot first: a victim stashed by this same call waits for the next
    // attempt instead of paying a second termination spawn immediately.
    const backlog = [...this.unverified]
    if (child) {
      this.detach(child)
      if (!(await terminateSidecarChild(child, this.deps.terminateImpl))) {
        this.unverified.add(child)
        verified = false
      }
    }
    for (const victim of backlog) {
      if (await terminateSidecarChild(victim, this.deps.terminateImpl)) {
        this.unverified.delete(victim)
      } else {
        verified = false
      }
    }
    this.shutdownVerified = verified && this.unverified.size === 0
    return this.shutdownVerified
  }

  private hostOpen(): boolean {
    return this.deps.isHostOpen?.() ?? true
  }

  private ensureStarted(): Promise<void> {
    if (this.child && !this.dead) {
      return Promise.resolve()
    }
    // Crashed sidecars restart on next invoke; start failures reject once.
    this.dead = null
    this.starting ??= startSidecarProcess({
      serviceId: this.serviceId,
      launch: this.launch,
      deps: this.deps,
      onSpawned: (child) => this.adopt(child),
      onStartFailed: () => {
        this.child = null
      },
      onLiveFailure: (error) => this.failAll(error),
      trackSteady: (child) => this.trackSteady(child)
    }).finally(() => {
      this.starting = null
    })
    return this.startAndGuard()
  }

  private async startAndGuard(): Promise<void> {
    await this.starting
    // The host may have disposed mid-start; drop the orphan deterministically
    // instead of serving requests from a torn-down scope.
    if (this.closed || !this.hostOpen()) {
      const orphan = this.child
      this.child = null
      if (orphan) {
        this.detach(orphan)
        await terminateSidecarChild(orphan, this.deps.terminateImpl)
      }
      throw serviceExecutionError('crashed', this.serviceId, 'service host is closed')
    }
  }

  private adopt(child: SpawnedProcess): void {
    this.child = child
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', () => {})
    }
    child.stdout?.on('data', this.onData)
    child.stderr?.on('data', this.onStderr)
  }

  private trackSteady(child: SpawnedProcess): void {
    const steadyError = (error: Error): void => {
      if (this.child !== child) {
        return
      }
      this.failAll(error)
    }
    const steadyExit = (): void => {
      if (this.child !== child) {
        return
      }
      this.failAll(serviceExecutionError('crashed', this.serviceId, 'service exited'))
    }
    this.steady = { owner: child, onError: steadyError, onExit: steadyExit }
    child.on('error', steadyError)
    child.on('exit', steadyExit)
  }

  private sendRequest(request: unknown, options: SidecarInvokeOptions): Promise<unknown> {
    return sendSidecarRequest(
      {
        serviceId: this.serviceId,
        child: this.child,
        dead: this.dead,
        pending: this.pending,
        deps: this.deps
      },
      request,
      {
        ...options,
        onTimeout: (timedOut) => this.onRequestTimeout(timedOut),
        onCancel: (cancelled) => {
          // Detaches the caller; the child stays alive for siblings.
          this.pending
            .take(cancelled)
            ?.reject(serviceExecutionError('cancelled', this.serviceId, 'request was cancelled'))
        }
      }
    )
  }

  private onRequestTimeout(id: string): void {
    const entry = this.pending.take(id)
    if (!entry) {
      return
    }
    entry.reject(serviceExecutionError('timeout', this.serviceId, 'service timed out'))
    const victim = this.child
    // Siblings shared the hung child; their outcome is unknowable too.
    if (this.pending.size > 0) {
      this.pending.failAll(serviceExecutionError('crashed', this.serviceId, 'service exited'))
    }
    void this.recycle(victim)
  }

  private onStdout(chunk: Buffer | string): void {
    // Byte-safe: a multibyte point split across events must not decode halves.
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const maxLine = this.deps.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    if (Buffer.byteLength(this.buffer, 'utf8') > maxLine * 4) {
      this.protocolViolation(
        serviceExecutionError('malformed-response', this.serviceId, 'unreadable response')
      )
      return
    }
    const { lines, rest } = splitFramedLines(this.buffer)
    this.buffer = rest
    for (const line of lines) {
      if (line.length === 0) {
        continue
      }
      this.onLine(line)
      if (this.closed) {
        return
      }
    }
  }

  private onLine(line: string): void {
    const maxResponse = this.deps.maxResponseBytes ?? 64 * 1024
    let record: { id: string; response: unknown }
    try {
      record = parseServiceRecord(line, this.serviceId, maxResponse)
    } catch (error) {
      this.protocolViolation(
        error instanceof ServiceExecutionError
          ? error
          : serviceExecutionError('malformed-response', this.serviceId, 'unreadable response')
      )
      return
    }
    const entry = this.pending.take(record.id)
    if (!entry) {
      return
    }
    entry.resolve(record.response)
  }

  // Ends this child but not the scope: retire the victim, then restart fresh.
  private protocolViolation(error: Error): void {
    const victim = this.child
    if (victim) {
      this.detach(victim)
    }
    this.child = null
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    this.failAll(error)
    if (victim) {
      void this.retireVictim(victim)
    }
  }

  // Detach + retire only the targeted child; detach is synchronous.
  private async recycle(victim: SpawnedProcess | null): Promise<void> {
    if (!victim || this.child !== victim) {
      return
    }
    this.detach(victim)
    this.child = null
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    await this.retireVictim(victim)
  }

  // Proven termination or tracked accountability for the retired victim.
  private async retireVictim(victim: SpawnedProcess): Promise<void> {
    if (await terminateSidecarChild(victim, this.deps.terminateImpl)) {
      return
    }
    this.unverified.add(victim)
  }

  private detach(child: SpawnedProcess): void {
    const steady = this.steady
    if (steady?.owner !== child) {
      return
    }
    this.steady = null
    child.off('error', steady.onError)
    child.off('exit', steady.onExit)
    child.stdout?.off('data', this.onData)
    child.stderr?.off('data', this.onStderr)
  }

  private failAll(error: Error): void {
    this.dead =
      error instanceof ServiceExecutionError
        ? error
        : serviceExecutionError('crashed', this.serviceId, 'service exited')
    // A crashed child may still deliver trailing stdout after exit; detach
    // first so its bytes can never parse as the replacement's stream.
    const deadChild = this.child
    if (deadChild) {
      this.detach(deadChild)
    }
    this.child = null
    this.steady = null
    this.pending.failAll(this.dead)
  }
}
