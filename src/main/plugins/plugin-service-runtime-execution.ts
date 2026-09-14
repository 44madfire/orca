import { isSafePluginServiceId } from '../../shared/plugins/plugin-capabilities'
import { buildWslExecArgs, quotePosixShell } from '../../shared/wsl-login-shell-command'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { isWslAvailable } from '../wsl-availability'
import { listWslDistros } from '../wsl'
import {
  resolveServiceWorktreeRuntime,
  serviceRuntimeScopeKey,
  type ServiceRuntimeProbe,
  type TrustedServiceWorktree
} from './plugin-service-worktree-runtime'
import { PluginServiceSidecar } from './plugin-service-sidecar-lifecycle'
import type { PluginServiceSidecarDeps, SidecarLaunch } from './plugin-service-sidecar-transport'
import { ServiceExecutionError, serviceExecutionError } from './plugin-service-execution-errors'

// Host-owned service definition. Panel supplies only the service id +
// structured payload; executable, argv, cwd, distro, and env never leave host code.
export type RegisteredServiceLaunch = {
  command: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  // Linux spelling inside the distro; defaults to command/args when omitted.
  wslCommand?: string
  wslArgs?: readonly string[]
}

export type RegisteredServiceDefinition = {
  serviceId: string
  launch: RegisteredServiceLaunch
  limits?: PluginServiceSidecarDeps
}

export type RuntimeServiceInvokeOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

export type PluginServiceRuntimeExecutionDeps = {
  platform?: NodeJS.Platform
  runtimeProbe?: ServiceRuntimeProbe
  spawnImpl?: typeof spawnProcess
  wslExecutable?: string
}

// Production WSL probes. Injected `runtimeProbe` fields override these, so
// tests stay off real wsl.exe while production always checks availability
// and the distro list before spawning (cached, bounded, shared with git/PTY).
export function defaultServiceRuntimeProbe(platform: NodeJS.Platform): ServiceRuntimeProbe {
  if (platform !== 'win32') {
    return { platform }
  }
  return {
    platform,
    isWslAvailable: () => isWslAvailable(),
    listWslDistros: () => listWslDistros()
  }
}

const MAX_COMMAND_LENGTH = 1024
const MAX_ARG_LENGTH = 8192
const MAX_ARGS = 128
const MAX_ENV_ENTRIES = 64
const MAX_ENV_VALUE_LENGTH = 32_768

function assertLaunch(launch: RegisteredServiceLaunch): void {
  const command = launch.command
  if (typeof command !== 'string' || command.length === 0 || command.length > MAX_COMMAND_LENGTH) {
    throw new Error('registered service launch needs a bounded command')
  }
  if (command.includes('\0') || command.includes('\n')) {
    throw new Error('registered service launch command is not portable')
  }
  const args = launch.args ?? []
  if (
    args.length > MAX_ARGS ||
    args.some((a) => typeof a !== 'string' || a.length > MAX_ARG_LENGTH || a.includes('\0'))
  ) {
    throw new Error('registered service launch args are not portable')
  }
  const entries = Object.entries(launch.env ?? {})
  if (
    entries.length > MAX_ENV_ENTRIES ||
    entries.some(
      ([k, v]) =>
        k.length === 0 || k.length > 256 || v.length > MAX_ENV_VALUE_LENGTH || /[\0\n]/.test(k + v)
    )
  ) {
    throw new Error('registered service launch env is not portable')
  }
}

// Provider-neutral execution over per-worktree sidecars. Worktree placement
// derives from host-authorized identity; concurrent worktrees never share a child.
export class PluginServiceRuntimeExecution {
  private readonly definitions = new Map<string, RegisteredServiceDefinition>()
  private readonly sidecars = new Map<string, PluginServiceSidecar>()
  private disposed = false

  constructor(private readonly deps: PluginServiceRuntimeExecutionDeps = {}) {}

  register(definition: RegisteredServiceDefinition): void {
    if (!isSafePluginServiceId(definition.serviceId)) {
      throw new Error(`unsafe service id: ${definition.serviceId}`)
    }
    assertLaunch(definition.launch)
    this.definitions.set(definition.serviceId, definition)
  }

  async invoke(input: {
    serviceId: string
    worktree: TrustedServiceWorktree
    request: unknown
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<unknown> {
    if (this.disposed) {
      throw serviceExecutionError('crashed', input.serviceId, 'service host is closed')
    }
    const definition = this.definitions.get(input.serviceId)
    if (!definition) {
      throw serviceExecutionError('service-unavailable', input.serviceId, 'unknown service')
    }
    const runtime = this.resolveRuntime(input.serviceId, input.worktree)
    const sidecar = this.sidecarFor(input.serviceId, definition, runtime)
    try {
      return await sidecar.invoke(input.request, {
        timeoutMs: input.timeoutMs,
        signal: input.signal
      })
    } catch (error) {
      throw this.withServiceId(error, input.serviceId)
    }
  }

  async closeScope(serviceId: string, worktree: TrustedServiceWorktree): Promise<void> {
    const runtime = this.resolveRuntime(serviceId, worktree)
    const key = serviceRuntimeScopeKey(serviceId, runtime)
    const sidecar = this.sidecars.get(key)
    if (!sidecar) {
      return
    }
    this.sidecars.delete(key)
    await sidecar.close()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await closeProcessRegistry({
      attempts: 3,
      hasEntries: () => [...this.sidecars.values()].length > 0,
      entryIds: () => new Set(this.sidecars.keys()),
      closeEntry: async (id) => {
        const sidecar = this.sidecars.get(id)
        if (!sidecar) {
          return true
        }
        this.sidecars.delete(id)
        await sidecar.close()
        return true
      },
      failureMessage: 'plugin service shutdown could not prove every sidecar stopped'
    })
  }

  private resolveRuntime(serviceId: string, worktree: TrustedServiceWorktree) {
    try {
      return resolveServiceWorktreeRuntime(worktree, {
        ...defaultServiceRuntimeProbe(this.deps.platform ?? process.platform),
        ...this.deps.runtimeProbe
      })
    } catch (error) {
      throw this.withServiceId(error, serviceId)
    }
  }

  private sidecarFor(
    serviceId: string,
    definition: RegisteredServiceDefinition,
    runtime: ReturnType<typeof resolveServiceWorktreeRuntime>
  ): PluginServiceSidecar {
    const key = serviceRuntimeScopeKey(serviceId, runtime)
    const existing = this.sidecars.get(key)
    if (existing) {
      return existing
    }
    const launch = this.buildLaunch(definition, runtime)
    const sidecar = new PluginServiceSidecar(serviceId, launch, {
      ...definition.limits,
      ...(this.deps.spawnImpl ? { spawnImpl: this.deps.spawnImpl } : {})
    })
    this.sidecars.set(key, sidecar)
    return sidecar
  }

  // Host owns every spawn fact: cwd from the trusted worktree, distro from
  // the trusted path, env from the registration. No panel field is read.
  private buildLaunch(
    definition: RegisteredServiceDefinition,
    runtime: ReturnType<typeof resolveServiceWorktreeRuntime>
  ): SidecarLaunch {
    const { launch } = definition
    const env = { ...launch.env }
    if (runtime.kind === 'native') {
      return {
        program: launch.command,
        args: [...(launch.args ?? [])],
        cwd: runtime.worktreePath,
        env
      }
    }
    const guestCommand = launch.wslCommand ?? launch.command
    const guestArgs = [...(launch.wslArgs ?? launch.args ?? [])]
    // Non-login `sh -c` with `cd && exec`: `--exec` keeps argv byte-exact
    // (no `$` expansion) and no login banner pollutes the JSONL stream.
    const assignments = Object.entries(env).map(([k, v]) => quotePosixShell(`${k}=${v}`))
    const script = [
      `cd ${quotePosixShell(runtime.linuxPath)}`,
      assignments.length > 0
        ? `exec /usr/bin/env ${assignments.join(' ')} ${quotePosixShell(guestCommand)}${guestArgs.map((a) => ` ${quotePosixShell(a)}`).join('')}`
        : `exec ${quotePosixShell(guestCommand)}${guestArgs.map((a) => ` ${quotePosixShell(a)}`).join('')}`
    ].join(' && ')
    return {
      program: this.deps.wslExecutable ?? 'wsl.exe',
      args: buildWslExecArgs(runtime.distro, ['sh', '-c', script]),
      cwd: resolveWslInteropSpawnCwd(),
      env: { SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows', WSL_UTF8: '1' }
    }
  }

  private withServiceId(error: unknown, serviceId: string): Error {
    if (error instanceof ServiceExecutionError) {
      if (error.serviceId === serviceId) {
        return error
      }
      return new ServiceExecutionError(error.code, serviceId)
    }
    return serviceExecutionError('crashed', serviceId, 'service failed')
  }
}
