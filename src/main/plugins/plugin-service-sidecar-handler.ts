import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'
import type { PluginHostServiceHandler } from './plugin-host-service-bindings'
import {
  normalizeServiceExecutionError,
  serviceExecutionError
} from './plugin-service-execution-errors'
import {
  resolveServiceWorktreeRuntime,
  serviceRuntimeScopeKey,
  type ServiceRuntimeProbe,
  type TrustedServiceWorktree
} from './plugin-service-worktree-runtime'
import type { RegisteredSidecarService } from './plugin-service-sidecar-spec'
import {
  ServiceSidecarController,
  type SidecarLifecycleDeps
} from './plugin-service-sidecar-lifecycle'
import { createSidecarJobBinder } from './plugin-service-windows-job'

export type SidecarHandlerDeps = {
  // Host-authorized worktree for the calling context. The panel proves
  // nothing; this callback (host runtime state) is the authority.
  resolveWorktree: () => Promise<TrustedServiceWorktree | null>
  runtimeProbe?: ServiceRuntimeProbe
  lifecycle?: SidecarLifecycleDeps
  reportKill?: (pid: number) => void
}

const DISPOSE_ATTEMPTS = 3

// Plug a registered sidecar behind the #5 service registry: the panel invokes
// the service id only, and this handler owns runtime resolution, launch, and
// lifecycle. No RPC/stream shape changes, so remote wire compat is untouched.
export function createSidecarServiceHandler(
  registration: RegisteredSidecarService,
  deps: SidecarHandlerDeps
): PluginHostServiceHandler & { dispose: () => Promise<void> } {
  const scopes = new Map<string, ServiceSidecarController>()
  const lifecycleBase = deps.lifecycle ?? {}
  const lifecycleDeps: SidecarLifecycleDeps = {
    ...lifecycleBase,
    jobBinder:
      lifecycleBase.jobBinder ??
      (process.platform === 'win32'
        ? createSidecarJobBinder(
            deps.reportKill ??
              ((pid) =>
                recordSelfInitiatedTreeKill({
                  pid,
                  site: 'service-sidecar-teardown',
                  scope: 'win-pty-job'
                }))
          )
        : null)
  }

  const invokeService = async (request: unknown) => {
    const worktree = await deps.resolveWorktree()
    if (!worktree) {
      throw serviceExecutionError('runtime-unavailable', registration.serviceId, 'unknown worktree')
    }
    let runtime
    try {
      runtime = await resolveServiceWorktreeRuntime(worktree, deps.runtimeProbe)
    } catch (error) {
      throw normalizeServiceExecutionError(error, registration.serviceId, 'runtime-unavailable')
    }
    const key = serviceRuntimeScopeKey(registration.serviceId, runtime)
    let controller = scopes.get(key)
    if (!controller) {
      // Launch construction runs only for a cold scope: a warm scope reuses
      // its sidecar without rebuilding the host-owned launch description.
      const launch = registration.buildLaunch(runtime)
      if (!launch) {
        throw serviceExecutionError('service-unavailable', registration.serviceId)
      }
      controller = new ServiceSidecarController(
        registration.serviceId,
        runtime,
        launch,
        registration,
        lifecycleDeps
      )
      scopes.set(key, controller)
    }
    try {
      return await controller.invoke(request)
    } catch (error) {
      throw normalizeServiceExecutionError(error, registration.serviceId, 'crashed')
    }
  }
  const disposeScopes = async (): Promise<void> => {
    await closeProcessRegistry({
      attempts: DISPOSE_ATTEMPTS,
      hasEntries: () => scopes.size > 0,
      entryIds: () => [...scopes.keys()],
      closeEntry: async (id) => {
        const controller = scopes.get(id)
        scopes.delete(id)
        if (!controller) {
          return true
        }
        try {
          await controller.dispose()
          return true
        } catch {
          return false
        }
      },
      failureMessage: `service ${registration.serviceId} teardown-unverified: sidecars may survive`
    })
  }
  const handler = Object.assign(invokeService, {
    dispose: () => disposeScopes()
  }) as PluginHostServiceHandler & { dispose: () => Promise<void> }
  return handler
}
