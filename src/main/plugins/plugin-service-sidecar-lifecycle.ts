import { randomUUID } from 'node:crypto'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'
import { ServiceExecutionError, serviceExecutionError } from './plugin-service-execution-errors'
import {
  SidecarPendingRequests,
  jsonBytes,
  parseServiceRecord,
  splitFramedLines,
  type PluginServiceSidecarDeps,
  type SidecarInvokeOptions,
  type SidecarLaunch
} from './plugin-service-sidecar-transport'

const STARTUP_GRACE_MS = 50
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_LINE_BYTES = 256 * 1024
// One long-lived child over bounded JSONL; requests correlate by id.
export class PluginServiceSidecar {
  private child: SpawnedProcess | null = null
  private buffer = ''
  private readonly pending = new SidecarPendingRequests()
  private dead: Error | null = null
  private starting: Promise<void> | null = null
  private closed = false

  constructor(
    private readonly serviceId: string,
    private readonly launch: SidecarLaunch,
    private readonly deps: PluginServiceSidecarDeps = {}
  ) {}
  get isRunning(): boolean {
    return this.child !== null && this.dead === null && !this.closed
  }

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

  async close(): Promise<void> {
    this.closed = true
    this.pending.drainForClose(this.serviceId)
    const child = this.child
    this.child = null
    this.buffer = ''
    if (!child) {
      return
    }
    await this.terminateChild(child)
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
        reject(
          error instanceof ServiceExecutionError
            ? error
            : serviceExecutionError('start-failed', this.serviceId, 'service failed to start')
        )
        return
      }
      this.child = child
      this.buffer = ''
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream?.on('error', () => {})
      }
      child.stdout?.on('data', (chunk: Buffer | string) => this.onStdout(chunk))
      child.stderr?.on('data', () => {})
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
          reject(serviceExecutionError('start-failed', this.serviceId, 'service failed to start'))
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
      const rewire = (): void => {
        child.off('error', onError)
        child.off('exit', onExit)
        child.on('error', (error: Error) => this.failAll(error))
        child.on('exit', () =>
          this.failAll(serviceExecutionError('crashed', this.serviceId, 'service exited'))
        )
      }
      child.once('error', onError)
      child.once('exit', onExit)
    })
  }

  private sendRequest(request: unknown, options: SidecarInvokeOptions): Promise<unknown> {
    const child = this.child
    if (!child || this.dead) {
      return Promise.reject(serviceExecutionError('crashed', this.serviceId, 'service exited'))
    }
    const id = randomUUID()
    const line = `${JSON.stringify({ id, request })}\n`
    const timeoutMs = options.timeoutMs ?? this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<unknown>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(serviceExecutionError('cancelled', this.serviceId, 'request was cancelled'))
        return
      }
      try {
        this.pending.add({
          id,
          resolve,
          reject,
          timeoutMs,
          signal: options.signal,
          onTimeout: (timedOut) => this.onRequestTimeout(timedOut),
          onCancel: (cancelled) => this.onRequestCancelled(cancelled)
        })
      } catch (error) {
        reject(
          error instanceof ServiceExecutionError
            ? error
            : serviceExecutionError('cancelled', this.serviceId, 'request was cancelled')
        )
        return
      }
      try {
        child.stdin?.write(line)
      } catch (error) {
        this.pending.take(id)
        reject(
          error instanceof ServiceExecutionError
            ? error
            : serviceExecutionError('crashed', this.serviceId, 'service exited')
        )
      }
    })
  }

  private onRequestTimeout(id: string): void {
    const entry = this.pending.take(id)
    if (!entry) {
      return
    }
    entry.reject(serviceExecutionError('timeout', this.serviceId, 'service timed out'))
    // Hung state is unknowable; recycle so the next invoke starts fresh.
    void this.recycle()
  }

  private onRequestCancelled(id: string): void {
    const entry = this.pending.take(id)
    if (!entry) {
      return
    }
    // Cancellation detaches the caller; the child stays alive for siblings.
    entry.reject(serviceExecutionError('cancelled', this.serviceId, 'request was cancelled'))
  }

  private onStdout(chunk: Buffer | string): void {
    this.buffer += chunk.toString()
    const maxLine = this.deps.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    if (Buffer.byteLength(this.buffer, 'utf8') > maxLine * 4) {
      this.failAll(
        serviceExecutionError('malformed-response', this.serviceId, 'unreadable response')
      )
      void this.close()
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
      this.failAll(
        error instanceof ServiceExecutionError
          ? error
          : serviceExecutionError('malformed-response', this.serviceId, 'unreadable response')
      )
      void this.close()
      return
    }
    const entry = this.pending.take(record.id)
    if (!entry) {
      return
    }
    entry.resolve(record.response)
  }

  private async recycle(): Promise<void> {
    const child = this.child
    this.child = null
    this.buffer = ''
    if (!child) {
      return
    }
    await this.terminateChild(child)
  }

  private async terminateChild(child: SpawnedProcess): Promise<void> {
    const terminate = this.deps.terminateImpl ?? forceTerminateProcessTree
    await terminate(child).catch(() => false)
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
  }

  private failAll(error: Error): void {
    this.dead =
      error instanceof ServiceExecutionError
        ? error
        : serviceExecutionError('crashed', this.serviceId, 'service exited')
    this.child = null
    const { dead } = this.pending.failAll(this.dead)
    void dead
  }
}
