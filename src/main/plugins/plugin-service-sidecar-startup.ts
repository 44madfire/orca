import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import {
  toStartError,
  type PluginServiceSidecarDeps,
  type SidecarLaunch
} from './plugin-service-sidecar-transport'
import { serviceExecutionError } from './plugin-service-execution-errors'

const STARTUP_GRACE_MS = 50

export type SidecarStartupEvents = {
  serviceId: string
  launch: SidecarLaunch
  deps: PluginServiceSidecarDeps
  onSpawned: (child: SpawnedProcess) => void
  onStartFailed: () => void
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
    let settled = false
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
        rewire()
        events.onStartFailed()
        reject(toStartError(error, events.serviceId))
        return
      }
      events.onLiveFailure(error)
    }
    const onExit = (code: unknown): void => {
      if (!settled) {
        settled = true
        clearTimeout(grace)
        rewire()
        events.onStartFailed()
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
    const rewire = (): void => {
      child.off('error', onError)
      child.off('exit', onExit)
      events.trackSteady(child)
    }
    child.once('error', onError)
    child.once('exit', onExit)
  })
}
