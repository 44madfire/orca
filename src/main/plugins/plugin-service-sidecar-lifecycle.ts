import { randomUUID } from 'node:crypto'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import {
  normalizeServiceExecutionError,
  serviceExecutionError
} from './plugin-service-execution-errors'
import type { ServiceWorktreeRuntime } from './plugin-service-worktree-runtime'
import type { SidecarLaunch, SidecarInvokeOptions } from './plugin-service-sidecar-spec'
import { buildSidecarSpawnSpec, resolveSidecarLimits } from './plugin-service-sidecar-spec'
import type { RegisteredSidecarService } from './plugin-service-sidecar-spec'
import {
  attachQuiet,
  createGeneration,
  detachGenerationStreams,
  encodeGenerationRequest,
  failGenerationPending,
  flushGeneration,
  markGenerationGuestChild,
  markGenerationReady,
  openGenerationFramer,
  pushGenerationMessage,
  pushGenerationStdout,
  type Generation,
  type GenerationStreamHooks,
  type SidecarLifecycleDeps
} from './plugin-service-sidecar-generation'
import { claimSidecarProcess } from './plugin-service-process-ownership'
import {
  createGenerationTeardown,
  stopSidecarGeneration,
  type GenerationTeardown
} from './plugin-service-sidecar-teardown'

export type { SidecarLifecycleDeps } from './plugin-service-sidecar-generation'

// One sidecar per (service, runtime scope). A promise-chain mutex serializes
// start/stop/recycle/dispose so they cannot race; every async continuation
// re-checks `current === gen`, so a stale generation can neither kill nor
// replace the current one. A crash fails its own pending requests and the
// next invoke deterministically starts a fresh generation.
export class ServiceSidecarController {
  private readonly serviceId: string
  private readonly runtime: ServiceWorktreeRuntime
  private readonly launch: SidecarLaunch
  private readonly limits: ReturnType<typeof resolveSidecarLimits>
  private readonly deps: SidecarLifecycleDeps
  private current: Generation | null = null
  private generationCounter = 0
  private requestCounter = 0
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    serviceId: string,
    runtime: ServiceWorktreeRuntime,
    launch: SidecarLaunch,
    service: RegisteredSidecarService,
    deps: SidecarLifecycleDeps = {}
  ) {
    this.serviceId = serviceId
    this.runtime = runtime
    this.launch = launch
    this.limits = resolveSidecarLimits(service)
    this.deps = deps
  }

  async invoke(payload: unknown, options: SidecarInvokeOptions = {}): Promise<unknown> {
    if (options.signal?.aborted) {
      throw serviceExecutionError('cancelled', this.serviceId)
    }
    if (this.closed) {
      throw serviceExecutionError('service-unavailable', this.serviceId, 'scope is closed')
    }
    const gen = await this.ensureRunning()
    if (gen.state !== 'ready' || !gen.child) {
      throw serviceExecutionError('crashed', this.serviceId, 'sidecar is not running')
    }
    if (gen.pending.size >= this.limits.maxPendingRequests) {
      throw serviceExecutionError('overloaded', this.serviceId, 'too many pending requests')
    }
    const id = `${gen.id}:${this.requestCounter++}`
    const encoded = encodeGenerationRequest(
      id,
      payload,
      this.serviceId,
      this.limits.maxMessageBytes
    )
    const stdin = gen.child?.stdin
    if (!stdin) {
      throw serviceExecutionError('crashed', this.serviceId, 'sidecar is not running')
    }
    const timeoutMs = options.timeoutMs ?? this.limits.requestTimeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (gen.pending.delete(id)) {
          cleanup()
          reject(serviceExecutionError('timeout', this.serviceId))
        }
      }, timeoutMs)
      timer.unref?.()
      // Wrapped settle removes the abort listener, so a caller-shared
      // signal never accumulates listeners across invokes.
      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        if (gen.pending.delete(id)) {
          cleanup()
          reject(serviceExecutionError('cancelled', this.serviceId))
        }
      }
      gen.pending.set(id, {
        timer,
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        }
      })
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        stdin.write(encoded)
      } catch {
        clearTimeout(timer)
        gen.pending.delete(id)
        throw serviceExecutionError('crashed', this.serviceId, 'sidecar is not running')
      }
    })
  }

  stop(): Promise<void> {
    return this.serialized(async () => {
      await stopSidecarGeneration(this.teardownContext(), this.current)
    })
  }

  dispose(): Promise<void> {
    return this.serialized(async () => {
      this.closed = true
      await stopSidecarGeneration(this.teardownContext(), this.current)
    })
  }

  private teardownContext(): GenerationTeardown {
    return createGenerationTeardown(
      this.serviceId,
      this.runtime,
      this.deps,
      (gen) => this.current === gen,
      (gen) => {
        if (this.current === gen) {
          this.current = null
        }
      }
    )
  }

  private streamHooks(): GenerationStreamHooks {
    return {
      isCurrent: (gen) => this.current === gen,
      markReady: (gen, supervisorPid) =>
        markGenerationReady(gen, supervisorPid, this.current === gen),
      markGuestChild: (gen, pid) => markGenerationGuestChild(gen, pid)
    }
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private ensureRunning(): Promise<Generation> {
    return this.serialized(async () => {
      if (this.closed) {
        throw serviceExecutionError('service-unavailable', this.serviceId, 'scope is closed')
      }
      const existing = this.current
      if (existing && (existing.state === 'ready' || existing.state === 'starting')) {
        await existing.readyPromise
        if (this.current === existing && existing.state === 'ready') {
          return existing
        }
        throw serviceExecutionError('start-failed', this.serviceId, 'sidecar failed to start')
      }
      return this.startGeneration()
    })
  }

  private async startGeneration(): Promise<Generation> {
    const platform = this.deps.platform ?? process.platform
    const id = ++this.generationCounter
    const nonce = (this.deps.createNonce ?? randomUUID)()
    const gen = createGeneration(id, nonce)
    this.current = gen
    const hooks = this.streamHooks()
    openGenerationFramer(
      gen,
      this.serviceId,
      this.limits.maxLineBytes,
      (messageGen, value) =>
        pushGenerationMessage(
          messageGen,
          value,
          this.serviceId,
          this.limits.maxMessageBytes,
          this.current === messageGen
        ),
      (framingGen, error) => failGenerationPending(framingGen, error, this.current === framingGen)
    )
    let child: SpawnedProcess
    try {
      child = (this.deps.spawnImpl ?? spawnProcess)(
        buildSidecarSpawnSpec(this.serviceId, this.launch, this.runtime, nonce, platform)
      )
    } catch {
      const error = serviceExecutionError('start-failed', this.serviceId, 'sidecar failed to start')
      gen.state = 'failed'
      gen.readyReject(error)
      throw error
    }
    gen.child = child
    const claim = claimSidecarProcess(child.pid, id, {
      ...this.deps.ownership,
      jobBinder: this.deps.jobBinder ?? null
    })
    if (!claim) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      gen.child = null
      const error = serviceExecutionError('start-failed', this.serviceId, 'sidecar failed to start')
      gen.state = 'failed'
      gen.readyReject(error)
      throw error
    }
    gen.claim = claim
    const isWsl = this.runtime.kind === 'wsl'
    attachQuiet(child, (chunk) => pushGenerationStdout(gen, chunk, isWsl, hooks))
    child.once('error', () => {
      this.onChildGone(gen, 'error')
    })
    // `close` (not `exit`) so the last responses still parse before crash accounting.
    child.once('close', (code) => {
      gen.exitCode = code
      this.onChildGone(gen, 'close')
    })
    if (!isWsl) {
      gen.state = 'ready'
      gen.readyResolve()
      return gen
    }
    // WSL readiness: the supervisor's nonce-bound READY line or bust. A
    // failed startup always tears the generation down first, so a
    // half-started child cannot leak behind the start-failed report.
    const grace = setTimeout(() => {
      if (this.current === gen && gen.state === 'starting') {
        try {
          gen.child?.kill()
        } catch {
          /* already gone */
        }
        gen.readyReject(
          serviceExecutionError('start-failed', this.serviceId, 'sidecar timed out starting')
        )
      }
    }, this.limits.startupGraceMs)
    grace.unref?.()
    try {
      await gen.readyPromise
    } catch {
      clearTimeout(grace)
      await stopSidecarGeneration(this.teardownContext(), gen)
      throw serviceExecutionError('start-failed', this.serviceId, 'sidecar failed to start')
    }
    clearTimeout(grace)
    if (this.current !== gen || gen.state !== 'ready') {
      throw serviceExecutionError('start-failed', this.serviceId, 'sidecar failed to start')
    }
    return gen
  }

  private onChildGone(gen: Generation, via: 'error' | 'close'): void {
    if (this.current !== gen) {
      detachGenerationStreams(gen)
      return
    }
    flushGeneration(gen, this.runtime.kind === 'wsl', this.streamHooks())
    detachGenerationStreams(gen)
    const wasReady = gen.state === 'ready'
    const stopping = gen.state === 'stopping'
    gen.state = 'failed'
    gen.child = null
    if (!stopping) {
      const error =
        !wasReady && via === 'close'
          ? serviceExecutionError('start-failed', this.serviceId, 'sidecar exited during startup')
          : normalizeServiceExecutionError(
              new Error('sidecar exited'),
              this.serviceId,
              wasReady ? 'crashed' : 'start-failed'
            )
      gen.readyReject(error)
      failGenerationPending(
        gen,
        wasReady
          ? error
          : serviceExecutionError('start-failed', this.serviceId, 'sidecar exited during startup'),
        true
      )
    }
  }
}
