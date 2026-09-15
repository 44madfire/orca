import { isAbsolute } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { runProcess } from '../../shared/child-process/run-process'
import { serviceExecutionError } from './plugin-service-execution-errors'

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
  // Seams for tests; production lists the real install with a bounded probe.
  parseWslUncPath?: (path: string) => { distro: string; linuxPath: string } | null
  listWslDistros?: () => Promise<string[]>
  probeTimeoutMs?: number
}

const MAX_ID_LENGTH = 512
const MAX_PATH_LENGTH = 4096
const WSL_LIST_TIMEOUT_MS = 5_000

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
// Remote (SSH/folder) paths that are not executable on this host fail closed:
// this layer owns local + WSL placement only, never silent local substitution.
export async function resolveServiceWorktreeRuntime(
  identity: TrustedServiceWorktree,
  probe: ServiceRuntimeProbe = {}
): Promise<ServiceWorktreeRuntime> {
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

async function resolveWslRuntime(
  identity: TrustedServiceWorktree,
  distro: string,
  linuxPath: string,
  probe: ServiceRuntimeProbe
): Promise<ServiceWorktreeRuntime> {
  if (!isBoundedId(distro)) {
    throw serviceExecutionError('distro-unavailable', '<unknown>', 'unavailable distribution')
  }
  if (!linuxPath.startsWith('/') || linuxPath.includes('\0')) {
    throw serviceExecutionError('runtime-unavailable', '<unknown>', 'unknown worktree')
  }
  const list = probe.listWslDistros ?? listInstalledWslDistros
  let installed: string[]
  try {
    installed = await list()
  } catch {
    throw serviceExecutionError('wsl-unavailable', '<unknown>', 'WSL runtime is unavailable')
  }
  if (!installed.includes(distro)) {
    const code = installed.length === 0 ? 'wsl-unavailable' : 'distro-unavailable'
    const detail =
      code === 'wsl-unavailable' ? 'WSL runtime is unavailable' : 'unavailable distribution'
    throw serviceExecutionError(code, '<unknown>', detail)
  }
  return {
    kind: 'wsl',
    worktreeId: identity.worktreeId,
    worktreePath: identity.path,
    distro,
    linuxPath
  }
}

// Bounded async probe: one `wsl.exe --list` to a deadline. Empty on any
// failure so callers report wsl-unavailable rather than hanging resolution.
async function listInstalledWslDistros(): Promise<string[]> {
  try {
    const result = await runProcess({
      program: 'wsl.exe',
      args: ['--list', '--quiet'],
      timeoutMs: WSL_LIST_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0) {
      return []
    }
    return result.stdout
      .split('\n')
      .map((line) => line.replace(/\0/g, '').trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
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
