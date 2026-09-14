import { StringDecoder } from 'node:string_decoder'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import { ServiceExecutionError, serviceExecutionError } from './plugin-service-execution-errors'
import {
  SidecarPendingRequests,
  jsonBytes,
  parseServiceRecord,
  sendSidecarRequest,
  splitFramedLines,
  terminateSidecarChild,
  toStartError,
  type PluginServiceSidecarDeps,
  type SidecarInvokeOptions,
  type SidecarLaunch
} from './plugin-service-sidecar-transport'

const STARTUP_GRACE_MS = 50
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
  private steady: {
    owner: SpawnedProcess
    onError: (error: Error) => void
    onExit: () => void
  } | null = null
  // Stable refs for detach.
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

  // True only when tree termination verified; false keeps the registry entry for retry.
  async close(): Promise<boolean> {
    this.closed = true
    this.pending.drainForClose(this.serviceId)
    const child = this.child
    this.child = null
    this.buffer = ''
    if (!child) {
      return this.shutdownVerified
    }
    this.detach(child)
    this.shutdownVerified = await terminateSidecarChild(child, this.deps.terminateImpl)
    return this.shutdownVerified
  }

  private ensureStarted(): Promise<void> {
    if (this.child && !this.dead) {
      return Promise.resolve()
    }
    // Crashed sidecars restart on next invoke; start failures reject once.
    this.dead = null
    this.starting ??= this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: SpawnedProcess
      try {
        const spawn = this.deps.spawnImpl ?? spawnProcess
        child = spawn({
          program: this.launch.program,
          args: [...this.launch.args],
          ...(this.launch.cwd !== undefined ? { cwd: this.launch.cwd } : {}),
          ...(this.launch.env !== undefined ? { env: this.launch.env } : {}),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32'
        }) as SpawnedProcess
      } catch (error) {
        reject(toStartError(error, this.serviceId))
        return
      }
      this.child = child
      this.buffer = ''
      this.decoder = new StringDecoder('utf8')
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream?.on('error', () => {})
      }
      child.stdout?.on('data', this.onData)
      child.stderr?.on('data', this.onStderr)
      let settled = false
      const grace = setTimeout(() => {
        if (!settled) {
          settled = true
          rewire()
          resolve()
        }
      }, this.deps.startupGraceMs ?? STARTUP_GRACE_MS)
      grace.unref?.()
      const onError = (error: Error): void => {
        if (!settled) {
          settled = true
          clearTimeout(grace)
          rewire()
          this.child = null
          reject(toStartError(error, this.serviceId))
          return
        }
        this.failAll(error)
      }
      const onExit = (code: unknown): void => {
        if (!settled) {
          settled = true
          clearTimeout(grace)
          rewire()
          this.child = null
          reject(
            serviceExecutionError(
              'start-failed',
              this.serviceId,
              `service exited during startup (code=${String(code)})`
            )
          )
          return
        }
        this.failAll(serviceExecutionError('crashed', this.serviceId, 'service exited'))
      }
      // Steady handlers ignore children they no longer own.
      const rewire = (): void => {
        child.off('error', onError)
        child.off('exit', onExit)
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
      child.once('error', onError)
      child.once('exit', onExit)
    })
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

  // Ends this child but not the scope: terminate the victim, then restart fresh.
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
      void terminateSidecarChild(victim, this.deps.terminateImpl)
    }
  }

  // Detach + terminate only the targeted child; detach is synchronous.
  private async recycle(victim: SpawnedProcess | null): Promise<void> {
    if (!victim || this.child !== victim) {
      return
    }
    this.detach(victim)
    this.child = null
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    await terminateSidecarChild(victim, this.deps.terminateImpl)
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
    this.child = null
    this.steady = null
    this.pending.failAll(this.dead)
  }
}
