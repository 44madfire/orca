import { isSafePluginServiceId } from '../../shared/plugins/plugin-capabilities'
import { buildWslExecArgs, quotePosixShell } from '../../shared/wsl-login-shell-command'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { isWslAvailableAsync } from '../wsl-availability'
import { listWslDistrosAsync } from '../wsl'
import {
  resolveServiceWorktreeRuntime,
  serviceRuntimeScopeKey,
  serviceTeardownScopeKey,
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

// Production WSL reality, read through the async cached probes so a wedged
// wsl.exe never blocks Electron main inside a service call. Injected
// `runtimeProbe` fields override these, so tests stay off real wsl.exe.
export async function defaultWin32ServiceProbe(
  platform: NodeJS.Platform
): Promise<ServiceRuntimeProbe> {
  if (platform !== 'win32') {
    return { platform }
  }
  const [available, distros] = await Promise.all([isWslAvailableAsync(), listWslDistrosAsync()])
  return {
    platform,
    isWslAvailable: () => available,
    listWslDistros: () => [...distros]
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
    const runtime = await this.resolveRuntime(input.serviceId, input.worktree)
    // Runtime resolution awaits; the host may have disposed meanwhile, so
    // re-check before installing or starting any child in a torn-down scope.
    if (this.disposed) {
      throw serviceExecutionError('crashed', input.serviceId, 'service host is closed')
    }
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

  // Teardown resolves the scope from path shape alone: a WSL runtime that
  // has since become unavailable must not shield a running sidecar from close.
  // Teardown keys off path shape alone so an unhealthy runtime cannot shield
  // a running sidecar; an unverified shutdown throws after bounded retries.
  async closeScope(serviceId: string, worktree: TrustedServiceWorktree): Promise<void> {
    const key = serviceTeardownScopeKey(serviceId, worktree, this.deps.platform ?? process.platform)
    const sidecar = this.sidecars.get(key)
    if (!sidecar) {
      return
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await sidecar.close()) {
        this.sidecars.delete(key)
        return
      }
    }
    throw serviceExecutionError('teardown-unverified', serviceId, 'service teardown is unverified')
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
        // The entry stays until shutdown verifies, so the retry path can
        // re-drive an unverified tree instead of forgetting a live child.
        if (await sidecar.close()) {
          this.sidecars.delete(id)
          return true
        }
        return false
      },
      failureMessage: 'plugin service shutdown could not prove every sidecar stopped'
    })
  }

  private async resolveRuntime(serviceId: string, worktree: TrustedServiceWorktree) {
    const platform = this.deps.platform ?? process.platform
    // Fast path: native worktrees need no WSL probes, so service calls never
    // pay for (or block on) wsl.exe unless the trusted path is UNC-shaped.
    if (platform !== 'win32' || !parseWslUncPath(worktree.path)) {
      try {
        return resolveServiceWorktreeRuntime(worktree, { platform })
      } catch (error) {
        throw this.withServiceId(error, serviceId)
      }
    }
    // Fully-injected probes stay synchronous for tests; otherwise snapshot
    // production reality once per call through the async cached probes.
    const injected = this.deps.runtimeProbe
    const probe: ServiceRuntimeProbe =
      injected?.isWslAvailable && injected?.listWslDistros
        ? { platform, ...injected }
        : { ...(await defaultWin32ServiceProbe(platform)), ...injected }
    try {
      return resolveServiceWorktreeRuntime(worktree, probe)
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
    if (this.disposed) {
      throw serviceExecutionError('crashed', serviceId, 'service host is closed')
    }
    const launch = this.buildLaunch(definition, runtime)
    const sidecar = new PluginServiceSidecar(serviceId, launch, {
      ...definition.limits,
      isHostOpen: () => !this.disposed,
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
