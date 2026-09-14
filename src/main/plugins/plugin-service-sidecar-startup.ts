import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import type {
  PluginServiceSidecarDeps,
  SidecarLaunch,
  SteadyChildHandlers
} from './plugin-service-sidecar-transport'
import { ServiceExecutionError, serviceExecutionError } from './plugin-service-execution-errors'
import { readServiceRootCreationTime } from './plugin-service-crashed-tree-sweep'

const STARTUP_GRACE_MS = 50
// Identity must never gate readiness: a wedged table reader would otherwise
// stall every invoke on this sidecar with no timeout to bound it.
const IDENTITY_TIMEOUT_MS = 5_000

// Missing executables stay `service-unavailable`, distinct from start failure.
function toStartError(error: unknown, serviceId: string): ServiceExecutionError {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return serviceExecutionError('service-unavailable', serviceId)
  }
  return error instanceof ServiceExecutionError
    ? error
    : serviceExecutionError('start-failed', serviceId, 'service failed to start')
}

export type SidecarStartupEvents = {
  serviceId: string
  launch: SidecarLaunch
  deps: PluginServiceSidecarDeps
  onSpawned: (child: SpawnedProcess) => void
  onStartFailed: (child: SpawnedProcess) => void
  onIdentity?: (child: SpawnedProcess, creationTimeMs: number | null) => void
  onLiveFailure: (error: Error) => void
  trackSteady: (child: SpawnedProcess) => void
}

// Spawn one sidecar child and prove it stays up past a short grace. Startup
// failures reject as service-unavailable/start-failed; anything later routes
// to onLiveFailure so the owner can detach and recycle deterministically.
export function startSidecarProcess(events: SidecarStartupEvents): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: SpawnedProcess
    try {
      const spawn = events.deps.spawnImpl ?? spawnProcess
      child = spawn({
        program: events.launch.program,
        args: [...events.launch.args],
        ...(events.launch.cwd !== undefined ? { cwd: events.launch.cwd } : {}),
        ...(events.launch.env !== undefined ? { env: events.launch.env } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      }) as SpawnedProcess
    } catch (error) {
      reject(toStartError(error, events.serviceId))
      return
    }
    events.onSpawned(child)
    // Bound while alive: resolves to null (never rejects) when unreadable.
    const readIdentity = events.deps.readRootCreationTime ?? readServiceRootCreationTime
    const identity = process.platform === 'win32' ? readIdentity(child.pid) : Promise.resolve(null)
    let settled = false
    // Identity is consumed regardless of the startup outcome: a child that
    // exits during the grace still needs its creation time bound to the
    // retired victim. Bounded so a wedged reader cannot pin the child.
    void Promise.race([
      identity,
      new Promise<null>((giveUp) => {
        const timer = setTimeout(() => giveUp(null), IDENTITY_TIMEOUT_MS)
        timer.unref?.()
      })
    ]).then((creationTimeMs) => {
      events.onIdentity?.(child, creationTimeMs)
    })
    const grace = setTimeout(() => {
      if (!settled) {
        settled = true
        rewire()
        resolve()
      }
    }, events.deps.startupGraceMs ?? STARTUP_GRACE_MS)
    grace.unref?.()
    const onError = (error: Error): void => {
      if (!settled) {
        settled = true
        clearTimeout(grace)
        dropStartupListeners()
        events.onStartFailed(child)
        reject(toStartError(error, events.serviceId))
        return
      }
      events.onLiveFailure(error)
    }
    const onExit = (code: unknown): void => {
      if (!settled) {
        settled = true
        clearTimeout(grace)
        dropStartupListeners()
        events.onStartFailed(child)
        reject(
          serviceExecutionError(
            'start-failed',
            events.serviceId,
            `service exited during startup (code=${String(code)})`
          )
        )
        return
      }
      events.onLiveFailure(serviceExecutionError('crashed', events.serviceId, 'service exited'))
    }
    const dropStartupListeners = (): void => {
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const rewire = (): void => {
      dropStartupListeners()
      events.trackSteady(child)
    }
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

// Identity-checked steady handlers: a recycled child's late exit can never
// fail the replacement's requests once ownership has moved on.
export function trackSteadyChild(
  child: SpawnedProcess,
  host: {
    serviceId: string
    isCurrent: () => boolean
    onFailure: (error: Error, failed: SpawnedProcess) => void
  }
): SteadyChildHandlers {
  const steadyError = (error: Error): void => {
    if (!host.isCurrent()) {
      return
    }
    host.onFailure(error, child)
  }
  const steadyExit = (): void => {
    if (!host.isCurrent()) {
      return
    }
    host.onFailure(serviceExecutionError('crashed', host.serviceId, 'service exited'), child)
  }
  const steady: SteadyChildHandlers = { owner: child, onError: steadyError, onExit: steadyExit }
  child.on('error', steadyError)
  child.on('exit', steadyExit)
  return steady
}
