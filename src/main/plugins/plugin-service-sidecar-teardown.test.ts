import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { PluginServiceRuntimeExecution } from './plugin-service-runtime-execution'
import { serviceRuntimeScopeKey, serviceTeardownScopeKey } from './plugin-service-worktree-runtime'
import type { ServiceExecutionError } from './plugin-service-execution-errors'
import type { PluginServiceSidecarDeps } from './plugin-service-sidecar-transport'
import {
  readServiceRootCreationTime,
  sweepCrashedServiceTree,
  type CrashedTreeRoot
} from './plugin-service-crashed-tree-sweep'

// Teardown-race coverage for the sidecar lifecycle (ORCA-UI1.2 round 4):
// in-flight retirement vs dispose, teardown without a healthy runtime,
// startup-grace failure hygiene, and crash tree accountability.

type FakeChild = EventEmitter & {
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdin: EventEmitter & { write: (line: string) => boolean }
  stdout: EventEmitter & { destroy?: () => void }
  stderr: EventEmitter & { destroy?: () => void }
  kill: () => boolean
}

function createFakeChild(onWrite: (line: string, child: FakeChild) => void): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = 2000 + Math.floor(Math.random() * 50000)
  child.exitCode = null
  child.signalCode = null
  child.stdout = new EventEmitter() as FakeChild['stdout']
  child.stderr = new EventEmitter() as FakeChild['stderr']
  child.stdin = Object.assign(new EventEmitter(), {
    write: (line: string) => {
      onWrite(line, child)
      return true
    }
  }) as FakeChild['stdin']
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

  it(
    'routes an exited child through the crash sweep on Windows',
    { skip: process.platform !== 'win32' },
    async () => {
      const swept: number[] = []
      const children: FakeChild[] = []
      const fakeSpawn = (() => {
        const child = createFakeChild(echoOnWrite((request) => ({ echo: request })))
        children.push(child)
        return child as unknown as ReturnType<typeof spawnProcess>
      }) as unknown as typeof spawnProcess
      const execution = new PluginServiceRuntimeExecution({
        platform: 'linux',
        spawnImpl: fakeSpawn
      })
      execution.register({
        serviceId: 'demo.dead-root',
        launch: { command: '/opt/host-owned/bridge', args: [], env: {} },
        limits: {
          terminateImpl: fakeTerminate,
          sweepCrashedTreeImpl: (async (root: CrashedTreeRoot) => {
            swept.push(root.pid)
            return true
          }) as unknown as PluginServiceSidecarDeps['sweepCrashedTreeImpl']
        }
      })
      const worktree = { worktreeId: 'wt', path: '/tmp/wt' }
      await expect(
        execution.invoke({ serviceId: 'demo.dead-root', worktree, request: null })
      ).resolves.toEqual({ echo: null })
      // Real exit semantics: exitCode is already set when the sweep must run.
      children[0]!.exitCode = 1
      children[0]?.emit('exit', 1, null)
      await expect(
        execution.invoke({ serviceId: 'demo.dead-root', worktree, request: null })
      ).resolves.toEqual({ echo: null })
      expect(swept).toEqual([children[0]?.pid])
      await execution.dispose()
    }
  )

  it(
    'tracks a dead root whose sweep cannot verify',
    { skip: process.platform !== 'win32' },
    async () => {
      const children: FakeChild[] = []
      const fakeSpawn = (() => {
        const child = createFakeChild(echoOnWrite((request) => ({ echo: request })))
        children.push(child)
        return child as unknown as ReturnType<typeof spawnProcess>
      }) as unknown as typeof spawnProcess
      const execution = new PluginServiceRuntimeExecution({
        platform: 'linux',
        spawnImpl: fakeSpawn
      })
      execution.register({
        serviceId: 'demo.dead-unverified',
        launch: { command: '/opt/host-owned/bridge', args: [], env: {} },
        limits: {
          terminateImpl: fakeTerminate,
          sweepCrashedTreeImpl: async () => false
        }
      })
      const worktree = { worktreeId: 'wt', path: '/tmp/wt' }
      await expect(
        execution.invoke({ serviceId: 'demo.dead-unverified', worktree, request: null })
      ).resolves.toEqual({ echo: null })
      children[0]!.exitCode = 1
      children[0]?.emit('exit', 1, null)
      await expect(
        execution.invoke({ serviceId: 'demo.dead-unverified', worktree, request: null })
      ).resolves.toEqual({ echo: null })
      await expect(execution.dispose()).rejects.toThrow(/could not prove every sidecar stopped/)
      await execution.dispose().catch(() => undefined)
    }
  )

  it('sweeps explicit descendant pids and verifies by absence', async () => {
    const table = [
      { pid: 11, ppid: 10, creationTimeMs: 101 },
      { pid: 12, ppid: 11, creationTimeMs: 102 },
      { pid: 13, ppid: 1, creationTimeMs: 103 }
    ]
    const killed: number[][] = []
    const dead = new Set<number>()
    const proven = await sweepCrashedServiceTree(
      { pid: 10, creationTimeMs: 100 },
      {
        platform: 'win32',
        readTable: async () => table.filter((row) => !dead.has(row.pid)),
        killPids: async (pids) => {
          killed.push([...pids])
          for (const pid of pids) {
            dead.add(pid)
          }
        }
      }
    )
    expect(proven).toBe(true)
    expect(killed).toEqual([[11, 12]])
  })

  it('refuses identity-ambiguous trees without killing', async () => {
    const killed: number[][] = []
    const killPids = async (pids: readonly number[]): Promise<void> => {
      killed.push([...pids])
    }
    const reused = await sweepCrashedServiceTree(
      { pid: 10, creationTimeMs: 100 },
      {
        platform: 'win32',
        readTable: async () => [
          { pid: 10, ppid: 1, creationTimeMs: 999 },
          { pid: 11, ppid: 10, creationTimeMs: 101 }
        ],
        killPids
      }
    )
    expect(reused).toBe(false)
    const live = await sweepCrashedServiceTree(
      { pid: 10, creationTimeMs: 100 },
      {
        platform: 'win32',
        readTable: async () => [
          { pid: 10, ppid: 1, creationTimeMs: 100 },
          { pid: 11, ppid: 10, creationTimeMs: 101 }
        ],
        killPids
      }
    )
    expect(live).toBe(false)
    const blind = await sweepCrashedServiceTree(
      { pid: 10, creationTimeMs: null },
      {
        platform: 'win32',
        readTable: async () => [{ pid: 10, ppid: 1, creationTimeMs: 100 }],
        killPids
      }
    )
    expect(blind).toBe(false)
    expect(killed).toEqual([])
  })

  it('keeps scanning until late descendants are gone', async () => {
    let nursing = true
    const killed: number[][] = []
    const dead = new Set<number>()
    const proven = await sweepCrashedServiceTree(
      { pid: 10, creationTimeMs: 100 },
      {
        platform: 'win32',
        readTable: async () => {
          const rows = [{ pid: 11, ppid: 10, creationTimeMs: 101 }].filter(
            (row) => !dead.has(row.pid)
          )
          if (!nursing && !dead.has(12)) {
            rows.push({ pid: 12, ppid: 11, creationTimeMs: 102 })
          }
          return rows
        },
        killPids: async (pids) => {
          killed.push([...pids])
          for (const pid of pids) {
            dead.add(pid)
          }
          nursing = false
        }
      }
    )
    expect(proven).toBe(true)
    expect(killed).toEqual([[11], [12]])
  })

  it('reads the live root creation time for later binding', async () => {
    const rows = [{ pid: 4242, ppid: 1, creationTimeMs: 555 }]
    await expect(
      readServiceRootCreationTime(4242, {
        platform: 'win32',
        readTable: async () => rows
      })
    ).resolves.toBe(555)
    await expect(
      readServiceRootCreationTime(9999, {
        platform: 'win32',
        readTable: async () => rows
      })
    ).resolves.toBeNull()
    await expect(readServiceRootCreationTime(4242, { platform: 'linux' })).resolves.toBeNull()
  })

  it('reports unverified when descendants survive or the table is unreadable', async () => {
    const table = [{ pid: 11, ppid: 10, creationTimeMs: 101 }]
    const survivors = await sweepCrashedServiceTree(
      { pid: 10, creationTimeMs: 100 },
      {
        platform: 'win32',
        readTable: async () => table,
        killPids: async () => undefined
      }
    )
    expect(survivors).toBe(false)
    const blind = await sweepCrashedServiceTree(
      { pid: 10, creationTimeMs: 100 },
      {
        platform: 'win32',
        readTable: async () => {
          throw new Error('no table')
        },
        killPids: async () => undefined
      }
    )
    expect(blind).toBe(false)
    expect(await sweepCrashedServiceTree({ pid: -1, creationTimeMs: null })).toBe(true)
  })

  it('rejects an oversized record even with a small response', async () => {
    const fakeSpawn = (() =>
      createFakeChild((line, child) => {
        const msg = JSON.parse(line) as { id: string }
        const record = `${JSON.stringify({ id: msg.id, response: 'ok', pad: 'x'.repeat(200) })}
`
        queueMicrotask(() => child.stdout.emit('data', record))
      }) as unknown as ReturnType<typeof spawnProcess>) as unknown as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register({
      serviceId: 'demo.wide-record',
      launch: { command: '/opt/host-owned/bridge', args: [], env: {} },
      limits: { maxLineBytes: 64, terminateImpl: fakeTerminate }
    })
    await expect(
      execution.invoke({
        serviceId: 'demo.wide-record',
        worktree: { worktreeId: 'wt', path: '/tmp/wt' },
        request: null
      })
    ).rejects.toMatchObject({ code: 'malformed-response' })
    await execution.dispose()
  })

  it('accepts many small records delivered in one chunk', async () => {
    const pending = new Map<string, (line: string, child: FakeChild) => void>()
    const fakeSpawn = (() =>
      createFakeChild((line, child) => {
        const msg = JSON.parse(line) as { id: string }
        pending.set(
          msg.id,
          echoOnWrite((request) => ({ echo: request }))
        )
        if (pending.size === 5) {
          const lines = [...pending.entries()]
            .map(([id]) => JSON.stringify({ id, response: { n: id.length } }))
            .join('\n')
          const targets = [...pending.values()]
          pending.clear()
          queueMicrotask(() => {
            child.stdout.emit('data', `${lines}\n`)
          })
          void targets
        }
      }) as unknown as ReturnType<typeof spawnProcess>) as unknown as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register({
      serviceId: 'demo.chunked',
      launch: { command: '/opt/host-owned/bridge', args: [], env: {} },
      // One record is ~73 bytes (uuid ids); five in one chunk exceed 4x this
      // bound in aggregate while every record is individually valid.
      limits: { maxLineBytes: 80, terminateImpl: fakeTerminate }
    })
    const worktree = { worktreeId: 'wt', path: '/tmp/wt' }
    const calls = Array.from({ length: 5 }, (_, n) =>
      execution.invoke({ serviceId: 'demo.chunked', worktree, request: { n } })
    )
    const responses = (await Promise.all(calls)) as { n: number }[]
    expect(responses).toEqual(Array.from({ length: 5 }, () => ({ n: 36 })))
    await execution.dispose()
  })

  it(
    'binds the crash sweep to the identity captured while alive',
    { skip: process.platform !== 'win32' },
    async () => {
      const seen: { pid: number; creationTimeMs: number | null }[] = []
      const children: FakeChild[] = []
      const fakeSpawn = (() => {
        const child = createFakeChild(echoOnWrite((request) => ({ echo: request })))
        children.push(child)
        return child as unknown as ReturnType<typeof spawnProcess>
      }) as unknown as typeof spawnProcess
      const execution = new PluginServiceRuntimeExecution({
        platform: 'linux',
        spawnImpl: fakeSpawn
      })
      execution.register({
        serviceId: 'demo.bound',
        launch: { command: '/opt/host-owned/bridge', args: [], env: {} },
        limits: {
          terminateImpl: fakeTerminate,
          readRootCreationTime: async () => 4242,
          sweepCrashedTreeImpl: (async (root: CrashedTreeRoot) => {
            seen.push({ pid: root.pid, creationTimeMs: root.creationTimeMs })
            return true
          }) as unknown as PluginServiceSidecarDeps['sweepCrashedTreeImpl']
        }
      })
      const worktree = { worktreeId: 'wt', path: '/tmp/wt' }
      await expect(
        execution.invoke({ serviceId: 'demo.bound', worktree, request: null })
      ).resolves.toEqual({ echo: null })
      const first = children[0]
      expect(first).toBeDefined()
      if (first) {
        first.exitCode = 1
        first.emit('exit', 1, null)
      }
      await expect(
        execution.invoke({ serviceId: 'demo.bound', worktree, request: null })
      ).resolves.toEqual({ echo: null })
      expect(seen).toEqual(first ? [{ pid: first.pid, creationTimeMs: 4242 }] : [])
      await execution.dispose()
    }
  )

  it('fails fast past the in-flight request cap', async () => {
    const fakeSpawn = (() =>
      createFakeChild(() => {}) as unknown as ReturnType<
        typeof spawnProcess
      >) as unknown as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register({
      serviceId: 'demo.capped',
      launch: { command: '/opt/host-owned/bridge', args: [], env: {} },
      limits: { maxPendingRequests: 2, terminateImpl: fakeTerminate }
    })
    const worktree = { worktreeId: 'wt', path: '/tmp/wt' }
    // Admission order under shared startup is unspecified: exactly one of
    // the three concurrent callers must fail fast while two stay queued.
    const codes: string[] = []
    for (const request of [{ n: 1 }, { n: 2 }, { n: 3 }]) {
      void execution.invoke({ serviceId: 'demo.capped', worktree, request }).then(
        () => codes.push('resolved'),
        (error: unknown) => codes.push((error as ServiceExecutionError).code)
      )
    }
    for (let waited = 0; codes.length < 1 && waited < 2000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(codes).toEqual(['overloaded'])
    await execution.dispose()
    for (let waited = 0; codes.length < 3 && waited < 2000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(codes.filter((code) => code === 'cancelled')).toHaveLength(2)
  })

  it('cleans up stalled-write listeners without dropping the response', async () => {
    const stdin = new EventEmitter()
    let writes = 0
    const fakeSpawn = (() => {
      const child = createFakeChild(() => {})
      const respond = (line: string): void => {
        echoOnWrite((request) => ({ echo: request }))(line, child)
      }
      child.stdin = Object.assign(stdin, {
        write: (line: string) => {
          writes += 1
          respond(line)
          queueMicrotask(() => stdin.emit('drain'))
          return false
        }
      }) as FakeChild['stdin']
      return child as unknown as ReturnType<typeof spawnProcess>
    }) as unknown as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register({
      serviceId: 'demo.backpressure',
      launch: { command: '/opt/host-owned/bridge', args: [], env: {} },
      limits: { terminateImpl: fakeTerminate }
    })
    // Drain arrives with the response; the request still resolves on time and
    // leaves no write listeners behind.
    await expect(
      execution.invoke({
        serviceId: 'demo.backpressure',
        worktree: { worktreeId: 'wt', path: '/tmp/wt' },
        request: null,
        timeoutMs: 2000
      })
    ).resolves.toEqual({ echo: null })
    expect(writes).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    // The write-scoped drain listener is gone; the permanent stream guard
    // installed at adopt stays until teardown detaches it.
    expect(stdin.listeners('drain').length).toBe(0)
    await execution.dispose()
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
