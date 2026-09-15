import { describe, expect, it } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import type { ServiceExecutionError } from './plugin-service-execution-errors'
import type { ServiceWorktreeRuntime } from './plugin-service-worktree-runtime'
import type { RegisteredSidecarService } from './plugin-service-sidecar-spec'
import { createSidecarServiceHandler } from './plugin-service-sidecar-handler'

const ECHO_SCRIPT = [
  "let b='';",
  "process.stdin.on('data',(c)=>{",
  'b+=c;let i;',
  "while((i=b.indexOf('\\n'))>=0){",
  'const l=b.slice(0,i);b=b.slice(i+1);',
  'if(!l.trim())continue;',
  'try{const m=JSON.parse(l);process.stdout.write(JSON.stringify({id:m.id,result:m.params})+',
  "'\\n');}catch{}",
  '}});'
].join('\n')

function echoRegistration(seen: ServiceWorktreeRuntime[]): RegisteredSidecarService {
  return {
    serviceId: 'svc.echo',
    buildLaunch: (runtime) => {
      seen.push(runtime)
      return { program: process.execPath, args: ['-e', ECHO_SCRIPT], env: { ...process.env } }
    }
  }
}

function worktree(id: string) {
  return { worktreeId: id, path: `/repo/${id}` }
}

// The registry handler returns `Promise<unknown> | unknown`; settle it
// through Promise.resolve so rejections surface as values for assertions.
async function invokeForTest(
  handler: (request: unknown, context: { pluginId: string; serviceId: string }) => unknown,
  request: unknown
): Promise<unknown> {
  try {
    return await Promise.resolve(handler(request, { pluginId: 'p', serviceId: 'svc.echo' }))
  } catch (error) {
    return error
  }
}

describe('createSidecarServiceHandler', () => {
  it('invokes through the host-resolved runtime, panel input never consulted', async () => {
    const seen: ServiceWorktreeRuntime[] = []
    const handler = createSidecarServiceHandler(echoRegistration(seen), {
      resolveWorktree: async () => worktree('wt-a'),
      runtimeProbe: { platform: 'linux' },
      lifecycle: { spawnImpl: (spec) => spawnProcess(spec) }
    })
    try {
      expect(await handler({ ping: 1 }, { pluginId: 'p', serviceId: 'svc.echo' })).toEqual({
        ping: 1
      })
      expect(seen).toEqual([{ kind: 'native', worktreeId: 'wt-a', worktreePath: '/repo/wt-a' }])
    } finally {
      await handler.dispose()
    }
  })

  it('fails closed without a host-authorized worktree', async () => {
    const handler = createSidecarServiceHandler(echoRegistration([]), {
      resolveWorktree: async () => null,
      runtimeProbe: { platform: 'linux' }
    })
    try {
      const error = await invokeForTest(handler, {})
      expect((error as ServiceExecutionError).code).toBe('runtime-unavailable')
    } finally {
      await handler.dispose()
    }
  })

  it('reports service-unavailable when the service is not installable there', async () => {
    const handler = createSidecarServiceHandler(
      { serviceId: 'svc.missing', buildLaunch: () => null },
      {
        resolveWorktree: async () => worktree('wt-a'),
        runtimeProbe: { platform: 'linux' }
      }
    )
    try {
      const error = await invokeForTest(handler, {})
      expect((error as ServiceExecutionError).code).toBe('service-unavailable')
    } finally {
      await handler.dispose()
    }
  })

  it('isolates two worktrees: neither reuses nor redirects the other', async () => {
    const seen: ServiceWorktreeRuntime[] = []
    let current = 'wt-a'
    const handler = createSidecarServiceHandler(echoRegistration(seen), {
      resolveWorktree: async () => worktree(current),
      runtimeProbe: { platform: 'linux' },
      lifecycle: { spawnImpl: (spec) => spawnProcess(spec) }
    })
    try {
      expect(await handler({ from: 'a' }, { pluginId: 'p', serviceId: 'svc.echo' })).toEqual({
        from: 'a'
      })
      current = 'wt-b'
      expect(await handler({ from: 'b' }, { pluginId: 'p', serviceId: 'svc.echo' })).toEqual({
        from: 'b'
      })
      expect(seen.map((runtime) => runtime.worktreeId)).toEqual(['wt-a', 'wt-b'])
      // A's scope still answers after B started: no shared execution context.
      current = 'wt-a'
      expect(await handler({ again: 1 }, { pluginId: 'p', serviceId: 'svc.echo' })).toEqual({
        again: 1
      })
      expect(seen.filter((runtime) => runtime.worktreeId === 'wt-a')).toHaveLength(1)
    } finally {
      await handler.dispose()
    }
  })

  it('dispose reports teardown failure and retains the scope for retry', async () => {
    const seen: ServiceWorktreeRuntime[] = []
    const spawned: { kill: () => void }[] = []
    let terminations = 0
    const handler = createSidecarServiceHandler(echoRegistration(seen), {
      resolveWorktree: async () => worktree('wt-a'),
      runtimeProbe: { platform: 'linux' },
      lifecycle: {
        spawnImpl: (spec) => {
          const child = spawnProcess(spec)
          spawned.push(child)
          return child
        },
        ownership: {
          terminateTree: async () => {
            terminations += 1
            return false
          },
          readCreationTimeMs: async () => 111,
          isPidAlive: () => true,
          verifyPollMs: 1,
          verifyDeadlineMs: 5
        }
      }
    })
    try {
      expect(await handler({ n: 1 }, { pluginId: 'p', serviceId: 'svc.echo' })).toEqual({ n: 1 })
      // The kill cannot be verified: dispose must fail loud, keep the scope,
      // and retry the exact teardown on the next dispose.
      await expect(handler.dispose()).rejects.toThrow('teardown-unverified')
      expect(terminations).toBeGreaterThanOrEqual(3)
      await expect(handler.dispose()).rejects.toThrow('teardown-unverified')
      expect(terminations).toBeGreaterThanOrEqual(6)
    } finally {
      for (const child of spawned) {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
    }
  })

  it('dispose leaves no scope behind and restarts cleanly', async () => {
    const seen: ServiceWorktreeRuntime[] = []
    const handler = createSidecarServiceHandler(echoRegistration(seen), {
      resolveWorktree: async () => worktree('wt-a'),
      runtimeProbe: { platform: 'linux' },
      lifecycle: { spawnImpl: (spec) => spawnProcess(spec) }
    })
    expect(await handler({ n: 1 }, { pluginId: 'p', serviceId: 'svc.echo' })).toEqual({ n: 1 })
    await handler.dispose()
    await handler.dispose()
    expect(await handler({ n: 2 }, { pluginId: 'p', serviceId: 'svc.echo' })).toEqual({ n: 2 })
    await handler.dispose()
  })
})
