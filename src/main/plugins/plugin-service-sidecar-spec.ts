import type { ProcessSpec } from '../../shared/child-process/process-spec'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { serviceExecutionError } from './plugin-service-execution-errors'
import type { ServiceWorktreeRuntime } from './plugin-service-worktree-runtime'
import { buildSupervisorArgv } from './plugin-service-wsl-supervisor'

// Host-built launch description. Constructed entirely from the service
// registration + resolved worktree runtime; panel input never reaches here.
export type SidecarLaunch = {
  program: string
  args: readonly string[]
  cwd?: string
  // Exact environment for the sidecar; never merged with process.env by the
  // lifecycle. Builders must include what the platform needs (SystemRoot on
  // Windows) and nothing the panel chose.
  env?: NodeJS.ProcessEnv
}

export type SidecarLimits = {
  startupGraceMs?: number
  requestTimeoutMs?: number
  // In-flight request cap; excess callers fail fast as overloaded.
  maxPendingRequests?: number
  maxLineBytes?: number
  maxMessageBytes?: number
}

// Trusted host-owned service registration. buildLaunch maps the resolved
// runtime to an executable/argv; null means not installable there.
export type RegisteredSidecarService = {
  serviceId: string
  buildLaunch: (runtime: ServiceWorktreeRuntime) => SidecarLaunch | null
  limits?: SidecarLimits
}

export type SidecarInvokeOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

export const DEFAULT_SIDECAR_STARTUP_GRACE_MS = 10_000
export const DEFAULT_SIDECAR_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_SIDECAR_MAX_PENDING_REQUESTS = 16
export const DEFAULT_SIDECAR_MAX_LINE_BYTES = 256 * 1024
export const DEFAULT_SIDECAR_MAX_MESSAGE_BYTES = 1024 * 1024

// Translate a host-built launch + resolved runtime into the exact spawn
// call. Native spawns carry the launch verbatim (exact env, explicit cwd);
// WSL spawns wrap the service argv in the guest supervisor under --exec.
export function buildSidecarSpawnSpec(
  serviceId: string,
  launch: SidecarLaunch,
  runtime: ServiceWorktreeRuntime,
  nonce: string,
  platform: NodeJS.Platform
): ProcessSpec {
  if (runtime.kind === 'wsl') {
    const serviceArgv = [launch.program, ...launch.args]
    if (serviceArgv.length === 0 || serviceArgv[0].length === 0) {
      throw serviceExecutionError('start-failed', serviceId, 'invalid sidecar registration')
    }
    return {
      program: 'wsl.exe',
      args: buildWslExecArgs(runtime.distro, [
        ...buildSupervisorArgv(nonce, runtime.linuxPath, serviceArgv, launch.env)
      ]),
      cwd: undefined,
      env: undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    }
  }
  if (launch.program.length === 0) {
    throw serviceExecutionError('start-failed', serviceId, 'invalid sidecar registration')
  }
  return {
    program: launch.program,
    args: [...launch.args],
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: platform !== 'win32'
  }
}

export function resolveSidecarLimits(service: RegisteredSidecarService): {
  startupGraceMs: number
  requestTimeoutMs: number
  maxPendingRequests: number
  maxLineBytes: number
  maxMessageBytes: number
} {
  return {
    startupGraceMs: service.limits?.startupGraceMs ?? DEFAULT_SIDECAR_STARTUP_GRACE_MS,
    requestTimeoutMs: service.limits?.requestTimeoutMs ?? DEFAULT_SIDECAR_REQUEST_TIMEOUT_MS,
    maxPendingRequests: service.limits?.maxPendingRequests ?? DEFAULT_SIDECAR_MAX_PENDING_REQUESTS,
    maxLineBytes: service.limits?.maxLineBytes ?? DEFAULT_SIDECAR_MAX_LINE_BYTES,
    maxMessageBytes: service.limits?.maxMessageBytes ?? DEFAULT_SIDECAR_MAX_MESSAGE_BYTES
  }
}
