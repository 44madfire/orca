import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { PluginServiceRuntimeExecution } from './plugin-service-runtime-execution'
import { serviceRuntimeScopeKey, serviceTeardownScopeKey } from './plugin-service-worktree-runtime'

// Teardown-race coverage for the sidecar lifecycle (ORCA-UI1.2 round 4):
// in-flight retirement vs dispose, teardown without a healthy runtime,
// startup-grace failure hygiene, and crash tree accountability.

type FakeChild = EventEmitter & {
  pid: number
  stdin: { write: (line: string) => void; on: () => void }
  stdout: EventEmitter & { destroy?: () => void }
  stderr: EventEmitter & { destroy?: () => void }
  kill: () => boolean
}

function createFakeChild(onWrite: (line: string, child: FakeChild) => void): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = 2000 + Math.floor(Math.random() * 50000)
  child.stdout = new EventEmitter() as FakeChild['stdout']
  child.stderr = new EventEmitter() as FakeChild['stderr']
  child.stdin = {
    write: (line: string) => {
      onWrite(line, child)
      return true
    },
    on: () => undefined
  }
  child.kill = () => {
    queueMicrotask(() => child.emit('exit', null, 'SIGKILL'))
    return true
  }
  return child
}

function echoOnWrite(respond: (request: unknown) => unknown) {
  return (line: string, child: FakeChild) => {
    for (const part of line.split('\n')) {
      if (!part.trim()) {
        continue
      }
      const msg = JSON.parse(part) as { id: string; request: unknown }
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          `${JSON.stringify({ id: msg.id, response: respond(msg.request) })}\n`
        )
      })
    }
  }
}

const fakeTerminate = async (): Promise<boolean> => true
const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\u\\wt'

describe('plugin service teardown races', () => {
  it('tracks an in-flight retirement through a concurrent dispose', async () => {
    let release!: (proven: boolean) => void
    const gate = new Promise<boolean>((resolve) => {
      release = resolve
    })
    let calls = 0
    let active = 0
    let maxActive = 0
    const fakeSpawn = (() =>
      createFakeChild(() => {}) as unknown as ReturnType<
        typeof spawnProcess
      >) as unknown as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register({
      serviceId: 'demo.gated',
      launch: { command: '/opt/host-owned/bridge', args: [], env: {} },
      limits: {
        requestTimeoutMs: 40,
        terminateImpl: () => {
          calls += 1
          active += 1
          maxActive = Math.max(maxActive, active)
          if (calls === 1) {
            return gate.finally(() => {
              active -= 1
            })
          }
          active -= 1
          return Promise.resolve(false)
        }
      }
    })
    const worktree = { worktreeId: 'wt', path: '/tmp/wt' }
    await expect(
      execution.invoke({ serviceId: 'demo.gated', worktree, request: null })
    ).rejects.toMatchObject({ code: 'timeout' })
    // Retirement call #1 is held; dispose must await it rather than doubling
    // the tree kill, then fail on the unverified victim instead of forgetting it.
    const disposing = execution.dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    release(false)
    await expect(disposing).rejects.toThrow(/could not prove every sidecar stopped/)
    expect(maxActive).toBe(1)
    expect(calls).toBeGreaterThanOrEqual(2)
    await execution.dispose().catch(() => undefined)
  })

  it('closes a WSL scope after the runtime becomes unavailable', async () => {
    const wsl = { available: true, distros: ['Ubuntu'] }
    let spawns = 0
    let terminations = 0
    const fakeSpawn = (() => {
      spawns += 1
      return createFakeChild(
        echoOnWrite((request) => ({ echo: request }))
      ) as unknown as ReturnType<typeof spawnProcess>
    }) as unknown as typeof spawnProcess as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({
      platform: 'win32',
      runtimeProbe: {
        platform: 'win32',
        parseWslUncPath,
        isWslAvailable: () => wsl.available,
        listWslDistros: () => [...wsl.distros]
      },
      spawnImpl: fakeSpawn
    })
    execution.register({
      serviceId: 'demo.wsl',
      launch: { command: '/usr/local/bin/demo-bridge', args: [], env: {} },
      limits: {
        terminateImpl: async () => {
          terminations += 1
          return true
        }
      }
    })
    const worktree = { worktreeId: 'wt', path: UNC }
    await expect(
      execution.invoke({ serviceId: 'demo.wsl', worktree, request: null })
    ).resolves.toEqual({ echo: null })
    expect(spawns).toBe(1)
    wsl.available = false
    wsl.distros = []
    await execution.closeScope('demo.wsl', worktree)
    expect(terminations).toBe(1)
    await expect(
      execution.invoke({ serviceId: 'demo.wsl', worktree, request: null })
    ).rejects.toMatchObject({ code: 'wsl-unavailable' })
    await execution.dispose()
  })

  it('drops a startup-grace failure without promoting it to steady state', async () => {
    const children: FakeChild[] = []
    const fakeSpawn = (() => {
      if (children.length === 0) {
        const failing = createFakeChild(() => {})
        children.push(failing)
        queueMicrotask(() => {
          failing.emit('exit', 1, null)
          // Truncated mid-emoji bytes arriving after the failure.
          const line = Buffer.from('{"id":"frag","response":"🎉"}\n', 'utf8')
          failing.stdout.emit('data', line.subarray(0, -4))
        })
        return failing as unknown as ReturnType<typeof spawnProcess>
      }
      const next = createFakeChild(echoOnWrite((request) => ({ echo: request })))
      children.push(next)
      return next as unknown as ReturnType<typeof spawnProcess>
    }) as unknown as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register({
      serviceId: 'demo.startup',
      launch: { command: '/opt/host-owned/bridge', args: [], env: {} },
      limits: { terminateImpl: fakeTerminate }
    })
    const worktree = { worktreeId: 'wt', path: '/tmp/wt' }
    await expect(
      execution.invoke({ serviceId: 'demo.startup', worktree, request: null })
    ).rejects.toMatchObject({ code: 'start-failed' })
    await expect(
      execution.invoke({ serviceId: 'demo.startup', worktree, request: { ok: true } })
    ).resolves.toEqual({ echo: { ok: true } })
    expect(children.length).toBe(2)
    await execution.dispose()
  })

  it('keeps crash tree accountability while restart stays available', async () => {
    let calls = 0
    const children: FakeChild[] = []
    const fakeSpawn = (() => {
      const child = createFakeChild(echoOnWrite((request) => ({ echo: request })))
      children.push(child)
      return child as unknown as ReturnType<typeof spawnProcess>
    }) as unknown as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register({
      serviceId: 'demo.crash-tree',
      launch: { command: '/opt/host-owned/bridge', args: [], env: {} },
      limits: {
        terminateImpl: () => {
          calls += 1
          return Promise.resolve(false)
        }
      }
    })
    const worktree = { worktreeId: 'wt', path: '/tmp/wt' }
    await expect(
      execution.invoke({ serviceId: 'demo.crash-tree', worktree, request: { n: 1 } })
    ).resolves.toEqual({ echo: { n: 1 } })
    children[0]?.emit('exit', 1, null)
    // Restart proceeds immediately, but the crashed root stays tracked.
    await expect(
      execution.invoke({ serviceId: 'demo.crash-tree', worktree, request: { n: 2 } })
    ).resolves.toEqual({ echo: { n: 2 } })
    await expect(execution.dispose()).rejects.toThrow(/could not prove every sidecar stopped/)
    expect(calls).toBeGreaterThanOrEqual(3)
    await execution.dispose().catch(() => undefined)
  })

  it('fails closeScope instead of silently keeping an unverified sidecar', async () => {
    const fakeSpawn = (() =>
      createFakeChild(echoOnWrite((request) => ({ echo: request }))) as unknown as ReturnType<
        typeof spawnProcess
      >) as unknown as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register({
      serviceId: 'demo.scope-unverified',
      launch: { command: '/opt/host-owned/bridge', args: [], env: {} },
      limits: { terminateImpl: async () => false }
    })
    const worktree = { worktreeId: 'wt', path: '/tmp/wt' }
    await expect(
      execution.invoke({ serviceId: 'demo.scope-unverified', worktree, request: null })
    ).resolves.toEqual({ echo: null })
    await expect(execution.closeScope('demo.scope-unverified', worktree)).rejects.toMatchObject({
      code: 'teardown-unverified'
    })
    await execution.dispose().catch(() => undefined)
  })

  it('derives teardown keys from path shape without health checks', () => {
    const wt = { worktreeId: 'wt', path: UNC }
    expect(serviceTeardownScopeKey('demo.svc', wt, 'win32')).toBe(
      serviceRuntimeScopeKey('demo.svc', { kind: 'wsl', worktreeId: 'wt', distro: 'Ubuntu' })
    )
    expect(serviceTeardownScopeKey('demo.svc', wt, 'linux')).toBe(
      serviceRuntimeScopeKey('demo.svc', { kind: 'native', worktreeId: 'wt' })
    )
  })
})
