import { isAbsolute } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  serviceExecutionError,
  type ServiceExecutionError
} from './plugin-service-execution-errors'

// Host-authorized worktree identity. Never panel-supplied: the caller (host
// runtime) proves the worktree; the panel supplies only a service id + payload.
export type TrustedServiceWorktree = {
  worktreeId: string
  path: string
}

export type ServiceWorktreeRuntime =
  | { kind: 'native'; worktreeId: string; worktreePath: string }
  | {
      kind: 'wsl'
      worktreeId: string
      worktreePath: string
      distro: string
      linuxPath: string
    }

export type ServiceRuntimeProbe = {
  platform?: NodeJS.Platform
  // Seams for tests; production reads the real WSL install.
  parseWslUncPath?: (path: string) => { distro: string; linuxPath: string } | null
  isWslAvailable?: () => boolean
  listWslDistros?: () => string[]
}

const MAX_ID_LENGTH = 512
const MAX_PATH_LENGTH = 4096

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function assertTrustedWorktree(identity: TrustedServiceWorktree): void {
  if (!isBoundedId(identity.worktreeId) || identity.worktreeId.includes('\0')) {
    throw serviceExecutionError('runtime-unavailable', '<unknown>', 'unknown worktree')
  }
  if (
    typeof identity.path !== 'string' ||
    identity.path.length === 0 ||
    identity.path.length > MAX_PATH_LENGTH ||
    identity.path.includes('\0')
  ) {
    throw serviceExecutionError('runtime-unavailable', '<unknown>', 'unknown worktree')
  }
}

// Resolve where a worktree's service executes, host-side. WSL detection uses
// the trusted path's UNC spelling; panel distro/cwd hints are never read.
// Direct callers must supply availability/distro probes; production defaults
// live in `defaultServiceRuntimeProbe` (used by PluginServiceRuntimeExecution).
export function resolveServiceWorktreeRuntime(
  identity: TrustedServiceWorktree,
  probe: ServiceRuntimeProbe = {}
): ServiceWorktreeRuntime {
  assertTrustedWorktree(identity)
  const platform = probe.platform ?? process.platform
  if (platform !== 'win32') {
    assertAbsoluteNative(identity.path)
    return { kind: 'native', worktreeId: identity.worktreeId, worktreePath: identity.path }
  }
  const parse = probe.parseWslUncPath ?? parseWslUncPath
  const wsl = parse(identity.path)
  if (!wsl) {
    assertAbsoluteNative(identity.path)
    return { kind: 'native', worktreeId: identity.worktreeId, worktreePath: identity.path }
  }
  return resolveWslRuntime(identity, wsl.distro, wsl.linuxPath, probe)
}

function resolveWslRuntime(
  identity: TrustedServiceWorktree,
  distro: string,
  linuxPath: string,
  probe: ServiceRuntimeProbe
): ServiceWorktreeRuntime {
  if (!isBoundedId(distro)) {
    throw serviceExecutionError('distro-unavailable', '<unknown>', 'unavailable distribution')
  }
  if (!linuxPath.startsWith('/') || linuxPath.includes('\0')) {
    throw serviceExecutionError(
      'runtime-unavailable',
      '<unknown>',
      'unknown worktree'
    ) as ServiceExecutionError
  }
  // Fail closed: without a probe there is no evidence the runtime exists.
  if (probe.isWslAvailable?.() !== true) {
    throw serviceExecutionError('wsl-unavailable', '<unknown>', 'WSL runtime is unavailable')
  }
  const known = probe.listWslDistros?.()
  if (!known) {
    throw serviceExecutionError('distro-unavailable', '<unknown>', 'unavailable distribution')
  }
  if (!known.includes(distro)) {
    throw serviceExecutionError('distro-unavailable', '<unknown>', 'unavailable distribution')
  }
  return {
    kind: 'wsl',
    worktreeId: identity.worktreeId,
    worktreePath: identity.path,
    distro,
    linuxPath
  }
}

function assertAbsoluteNative(path: string): void {
  // UNC paths are WSL or remote shares; a native Windows cwd must be a drive path.
  if (!isAbsolute(path) || path.startsWith('\\\\')) {
    throw serviceExecutionError('runtime-unavailable', '<unknown>', 'unknown worktree')
  }
}

// Isolation key: native/WSL copies of one worktree id never share a sidecar.
// NUL-joined so no component can forge a collision.
export function serviceRuntimeScopeKey(
  serviceId: string,
  runtime: Pick<ServiceWorktreeRuntime, 'kind' | 'worktreeId'> & { distro?: string }
): string {
  return [
    serviceId,
    runtime.kind,
    runtime.kind === 'wsl' ? (runtime.distro ?? '') : '',
    runtime.worktreeId
  ].join('\u0000')
}

// Teardown key without health checks: locating an existing scope for close
// must not depend on WSL currently answering, exactly when teardown matters.
export function serviceTeardownScopeKey(
  serviceId: string,
  identity: TrustedServiceWorktree,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    const wsl = parseWslUncPath(identity.path)
    if (wsl && wsl.distro) {
      return serviceRuntimeScopeKey(serviceId, {
        kind: 'wsl',
        worktreeId: identity.worktreeId,
        distro: wsl.distro
      })
    }
  }
  return serviceRuntimeScopeKey(serviceId, { kind: 'native', worktreeId: identity.worktreeId })
}
