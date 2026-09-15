import { describe, expect, it } from 'vitest'
import { ServiceExecutionError } from './plugin-service-execution-errors'
import {
  resolveServiceWorktreeRuntime,
  serviceRuntimeScopeKey
} from './plugin-service-worktree-runtime'

const DISTRO = 'Ubuntu-24.04'

async function resolve(identity: { worktreeId: string; path: string }, probe: object = {}) {
  return resolveServiceWorktreeRuntime(identity, { platform: 'linux', ...probe })
}

describe('resolveServiceWorktreeRuntime', () => {
  it('resolves a native runtime from trusted POSIX state', async () => {
    const runtime = await resolve({ worktreeId: 'wt-1', path: '/home/you/repo' })
    expect(runtime).toEqual({ kind: 'native', worktreeId: 'wt-1', worktreePath: '/home/you/repo' })
  })

  it('resolves a native Windows runtime for a drive path', async () => {
    const runtime = await resolveServiceWorktreeRuntime(
      { worktreeId: 'wt-1', path: 'C:\\Users\\you\\repo' },
      { platform: 'win32' }
    )
    expect(runtime.kind).toBe('native')
  })

  it('resolves WSL placement from the trusted UNC spelling', async () => {
    const runtime = await resolveServiceWorktreeRuntime(
      { worktreeId: 'wt-1', path: `\\\\wsl.localhost\\${DISTRO}\\home\\you\\repo` },
      { platform: 'win32', listWslDistros: async () => [DISTRO] }
    )
    expect(runtime).toEqual({
      kind: 'wsl',
      worktreeId: 'wt-1',
      worktreePath: `\\\\wsl.localhost\\${DISTRO}\\home\\you\\repo`,
      distro: DISTRO,
      linuxPath: '/home/you/repo'
    })
  })

  it('ignores panel-supplied hints: only the trusted path decides', async () => {
    // No probe field exists for a panel distro/cwd, so there is nothing to
    // pass that could redirect placement. A native path stays native.
    const runtime = await resolveServiceWorktreeRuntime(
      { worktreeId: 'wt-1', path: 'C:\\Users\\you\\repo' },
      { platform: 'win32' }
    )
    expect(runtime.kind).toBe('native')
  })

  it('fails closed when WSL is unavailable', async () => {
    const error = await resolveServiceWorktreeRuntime(
      { worktreeId: 'wt-1', path: `\\\\wsl.localhost\\${DISTRO}\\home\\you\\repo` },
      { platform: 'win32', listWslDistros: async () => [] }
    ).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ServiceExecutionError)
    expect((error as ServiceExecutionError).code).toBe('wsl-unavailable')
    expect((error as Error).message).not.toContain(DISTRO)
  })

  it('fails closed when the distro is unknown', async () => {
    const error = await resolveServiceWorktreeRuntime(
      { worktreeId: 'wt-1', path: '\\\\wsl.localhost\\Other\\home\\you\\repo' },
      { platform: 'win32', listWslDistros: async () => [DISTRO] }
    ).catch((error: unknown) => error)
    expect((error as ServiceExecutionError).code).toBe('distro-unavailable')
  })

  it('fails closed when the WSL probe throws', async () => {
    const error = await resolveServiceWorktreeRuntime(
      { worktreeId: 'wt-1', path: `\\\\wsl.localhost\\${DISTRO}\\home\\you\\repo` },
      {
        platform: 'win32',
        listWslDistros: async () => {
          throw new Error('wsl.exe exploded with secrets')
        }
      }
    ).catch((error: unknown) => error)
    expect((error as ServiceExecutionError).code).toBe('wsl-unavailable')
    expect((error as Error).message).not.toContain('secrets')
  })

  it('rejects untrusted worktree identities without host facts', async () => {
    for (const identity of [
      { worktreeId: '', path: '/home/you/repo' },
      { worktreeId: 'wt\0x', path: '/home/you/repo' },
      { worktreeId: 'wt-1', path: '' },
      { worktreeId: 'wt-1', path: 'relative/path' },
      { worktreeId: 'wt-1', path: '/home/you/repo\0' }
    ]) {
      const error = await resolve(identity).catch((error: unknown) => error)
      expect((error as ServiceExecutionError).code).toBe('runtime-unavailable')
      expect((error as Error).message).not.toContain('relative')
    }
  })

  it('never treats a bare UNC share as a native cwd', async () => {
    const error = await resolveServiceWorktreeRuntime(
      { worktreeId: 'wt-1', path: '\\\\fileserver\\share\\repo' },
      { platform: 'win32' }
    ).catch((error: unknown) => error)
    expect((error as ServiceExecutionError).code).toBe('runtime-unavailable')
  })
})

describe('serviceRuntimeScopeKey', () => {
  it('isolates native from WSL copies of one worktree', () => {
    const native = serviceRuntimeScopeKey('svc', { kind: 'native', worktreeId: 'wt' })
    const wsl = serviceRuntimeScopeKey('svc', { kind: 'wsl', worktreeId: 'wt', distro: DISTRO })
    expect(native).not.toBe(wsl)
  })

  it('isolates two worktrees on the same runtime', () => {
    const a = serviceRuntimeScopeKey('svc', { kind: 'native', worktreeId: 'wt-a' })
    const b = serviceRuntimeScopeKey('svc', { kind: 'native', worktreeId: 'wt-b' })
    expect(a).not.toBe(b)
  })

  it('isolates distros and services', () => {
    const a = serviceRuntimeScopeKey('svc', { kind: 'wsl', worktreeId: 'wt', distro: 'A' })
    const b = serviceRuntimeScopeKey('svc', { kind: 'wsl', worktreeId: 'wt', distro: 'B' })
    const c = serviceRuntimeScopeKey('other', { kind: 'wsl', worktreeId: 'wt', distro: 'A' })
    expect(new Set([a, b, c]).size).toBe(3)
  })
})
