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
  failGenerationPending,
  flushGeneration,
  markGenerationReady,
  openGenerationFramer,
  pushGenerationMessage,
  pushGenerationStdout,
  sendGenerationRequest,
  type Generation,
  type GenerationStreamHooks,
  type SidecarLifecycleDeps
} from './plugin-service-sidecar-generation'
import { claimSidecarProcess } from './plugin-service-process-ownership'
import {
  createGenerationTeardown,
  createOrphanTracker,
  stopSidecarGeneration,
  type GenerationTeardown,
  type OrphanTracker
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
  private readonly orphans: OrphanTracker = createOrphanTracker()
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
    const gen = await this.ensureRunningAbortable(options.signal)
    if (gen.state !== 'ready' || !gen.child) {
      throw serviceExecutionError('crashed', this.serviceId, 'sidecar is not running')
    }
    if (gen.pending.size >= this.limits.maxPendingRequests) {
      throw serviceExecutionError('overloaded', this.serviceId, 'too many pending requests')
    }
    const id = `${gen.id}:${this.requestCounter++}`
    const stdin = gen.child?.stdin
    if (!stdin) {
      throw serviceExecutionError('crashed', this.serviceId, 'sidecar is not running')
    }
    return sendGenerationRequest(gen, id, payload, {
      serviceId: this.serviceId,
      maxMessageBytes: this.limits.maxMessageBytes,
      timeoutMs: options.timeoutMs ?? this.limits.requestTimeoutMs,
      signal: options.signal,
      send: (bytes) => stdin.write(bytes)
    })
  }

  stop(): Promise<void> {
    return this.serialized(async () => {
      // Reap orphaned guests first: a failed sweep keeps the records and
      // fails loud instead of stopping beside a possibly-live guest.
      await this.orphans.sweep(this.deps, this.serviceId)
      await stopSidecarGeneration(this.teardownContext(), this.current)
    })
  }

  dispose(): Promise<void> {
    return this.serialized(async () => {
      this.closed = true
      await this.orphans.sweep(this.deps, this.serviceId)
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
      },
      (orphan) => this.orphans.note(orphan)
    )
  }

  private streamHooks(): GenerationStreamHooks {
    return {
      isCurrent: (gen) => this.current === gen,
      markReady: (gen, supervisorPid) =>
        markGenerationReady(gen, supervisorPid, this.current === gen)
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

  // Startup itself is abort-aware: the race rejects the caller on abort
  // while the shared generation keeps starting for later invokes.
  private ensureRunningAbortable(signal?: AbortSignal): Promise<Generation> {
    if (!signal) {
      return this.ensureRunning()
    }
    if (signal.aborted) {
      return Promise.reject(serviceExecutionError('cancelled', this.serviceId))
    }
    let onAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(serviceExecutionError('cancelled', this.serviceId))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    return Promise.race([this.ensureRunning(), aborted]).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
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
      // Settle anything left behind (a failed-live generation keeps its
      // child + claim for exactly this retry) before starting fresh, so a
      // replacement never starts beside an unverified tree.
      if (existing) {
        await stopSidecarGeneration(this.teardownContext(), existing)
      }
      return this.startGeneration()
    })
  }

  private async startGeneration(): Promise<Generation> {
    // A replacement never starts beside a possibly-live orphan: reap first.
    await this.orphans.sweep(this.deps, this.serviceId)
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
      const error = serviceExecutionError('start-failed', this.serviceId, 'sidecar failed to start')
      gen.state = 'failed'
      gen.readyReject(error)
      // Best-effort root kill for the unclaimable child; this teardown path
      // holds no claim and never throws.
      await stopSidecarGeneration(this.teardownContext(), gen)
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
    // Losing the wrapper is not losing the guest: preserve the in-distro
    // identity so restart/stop sweeps the supervisor with proof. Pids may
    // both be null here; the tracker drops pid-less records itself.
    if (this.runtime.kind === 'wsl') {
      this.orphans.note({
        distro: this.runtime.distro,
        nonce: gen.nonce,
        supervisorPid: gen.guestSupervisorPid,
        childPid: gen.guestChildPid
      })
    }
    if (gen.state === 'stopping') {
      // Owned by an in-flight stopSidecarGeneration: leave child + claim
      // for its verification instead of stealing them here.
      return
    }
    const wasReady = gen.state === 'ready'
    gen.state = 'failed'
    gen.child = null
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
