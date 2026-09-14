import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import {
  PluginServiceRuntimeExecution,
  type RegisteredServiceDefinition
} from './plugin-service-runtime-execution'
import { ServiceExecutionError } from './plugin-service-execution-errors'
import { resolveServiceWorktreeRuntime } from './plugin-service-worktree-runtime'

const ECHO_SCRIPT = [
  "const rl=require('readline').createInterface({input:process.stdin});",
  "rl.on('line',(line)=>{",
  'if(!line.trim())return;',
  'try{const m=JSON.parse(line);',
  "process.stdout.write(JSON.stringify({id:m.id,response:{echo:m.request}})+'\\n');",
  '}catch{}',
  '});'
].join('\n')

function nativeEchoDefinition(
  serviceId: string,
  cwdNote?: string,
  limits?: RegisteredServiceDefinition['limits']
): RegisteredServiceDefinition {
  void cwdNote
  return {
    serviceId,
    launch: { command: process.execPath, args: ['-e', ECHO_SCRIPT], env: {} },
    ...(limits ? { limits } : {})
  }
}

// Minimal fake child speaking the sidecar JSONL protocol.
type FakeChild = EventEmitter & {
  pid: number
  stdin: { write: (line: string) => void; on: () => void; destroy?: () => void }
  stdout: EventEmitter & { destroy?: () => void }
  stderr: EventEmitter & { destroy?: () => void }
  kill: () => boolean
  exitCode: null
  signalCode: undefined
}

function createFakeChild(onWrite: (line: string, child: FakeChild) => void): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = 1000 + Math.floor(Math.random() * 50000)
  child.exitCode = null
  child.signalCode = undefined
  const stdout = new EventEmitter() as FakeChild['stdout']
  const stderr = new EventEmitter() as FakeChild['stderr']
  child.stdout = stdout
  child.stderr = stderr
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

describe('plugin service runtime execution (ORCA-UI1.2)', () => {
  it('executes a registered service in a native worktree without generic exec', async () => {
    const execution = new PluginServiceRuntimeExecution({ platform: process.platform })
    execution.register(nativeEchoDefinition('demo.echo'))
    const worktree = { worktreeId: 'wt-native', path: tmpdir() }
    const response = (await execution.invoke({
      serviceId: 'demo.echo',
      worktree,
      request: { op: 'ping' }
    })) as { echo: unknown }
    expect(response).toEqual({ echo: { op: 'ping' } })
    await execution.dispose()
  })

  it('resolves the WSL distro from host-authorized state and launches via wsl.exe --exec', async () => {
    const launches: { program: string; args: readonly string[]; cwd?: string }[] = []
    const fakeSpawn = ((spec: { program: string; args?: readonly string[]; cwd?: string }) => {
      launches.push({ program: spec.program, args: [...(spec.args ?? [])], cwd: spec.cwd })
      return createFakeChild(
        echoOnWrite((request) => ({ echo: request }))
      ) as unknown as ReturnType<typeof spawnProcess>
    }) as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({
      platform: 'win32',
      runtimeProbe: {
        platform: 'win32',
        parseWslUncPath: () => ({ distro: 'Ubuntu', linuxPath: '/home/user/trees/demo' }),
        isWslAvailable: () => true,
        listWslDistros: () => ['Ubuntu']
      },
      spawnImpl: fakeSpawn
    })
    execution.register({
      serviceId: 'demo.bridge',
      launch: {
        command: '/usr/local/bin/demo-bridge',
        args: ['--serve'],
        env: { BRIDGE_MODE: 'rpc' }
      }
    })
    const response = await execution.invoke({
      serviceId: 'demo.bridge',
      worktree: {
        worktreeId: 'wt-wsl',
        path: '\\\\wsl.localhost\\Ubuntu\\home\\user\\trees\\demo'
      },
      request: { op: 'ping' }
    })
    expect(response).toEqual({ echo: { op: 'ping' } })
    expect(launches).toHaveLength(1)
    expect(launches[0]?.program).toBe('wsl.exe')
    const args = launches[0]?.args ?? []
    expect(args).toContain('--exec')
    expect(args).toContain('Ubuntu')
    expect(args.join(' ')).toContain('/home/user/trees/demo')
    expect(args.join(' ')).toContain('/usr/local/bin/demo-bridge')
    expect(args.join(' ')).not.toContain('-ilc')
    await execution.dispose()
  })

  it('ignores exec-shaped fields smuggled in the structured request', async () => {
    const launches: { program: string; args: readonly string[] }[] = []
    const fakeSpawn = ((spec: { program: string; args?: readonly string[] }) => {
      launches.push({ program: spec.program, args: [...(spec.args ?? [])] })
      return createFakeChild(
        echoOnWrite((request) => ({ echo: request }))
      ) as unknown as ReturnType<typeof spawnProcess>
    }) as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register({
      serviceId: 'demo.fixed',
      launch: { command: '/opt/host-owned/bridge', args: ['--serve'], env: {} }
    })
    await execution.invoke({
      serviceId: 'demo.fixed',
      worktree: { worktreeId: 'wt-a', path: '/tmp/wt-a' },
      request: { cmd: 'rm -rf /', distro: 'evil', cwd: '/evil', env: { EVIL: '1' } }
    })
    expect(launches[0]?.program).toBe('/opt/host-owned/bridge')
    expect(launches[0]?.args.join(' ')).not.toContain('evil')
    await execution.dispose()
  })

  it('fails deterministically when the WSL runtime or distro is unavailable', async () => {
    const missing = new PluginServiceRuntimeExecution({
      platform: 'win32',
      runtimeProbe: {
        platform: 'win32',
        parseWslUncPath: () => ({ distro: 'Ubuntu', linuxPath: '/home/u/wt' }),
        isWslAvailable: () => false,
        listWslDistros: () => ['Ubuntu']
      },
      spawnImpl: (() => {
        throw new Error('must not spawn')
      }) as unknown as typeof spawnProcess
    })
    missing.register({ serviceId: 'demo.svc', launch: { command: '/bin/svc', env: {} } })
    await expect(
      missing.invoke({
        serviceId: 'demo.svc',
        worktree: { worktreeId: 'wt', path: '\\\\wsl$\\Ubuntu\\home\\u\\wt' },
        request: null
      })
    ).rejects.toMatchObject({ code: 'wsl-unavailable' })
    await missing.dispose()

    const unknownDistro = new PluginServiceRuntimeExecution({
      platform: 'win32',
      runtimeProbe: {
        platform: 'win32',
        parseWslUncPath: () => ({ distro: 'Gone', linuxPath: '/home/u/wt' }),
        isWslAvailable: () => true,
        listWslDistros: () => ['Ubuntu']
      }
    })
    unknownDistro.register({ serviceId: 'demo.svc', launch: { command: '/bin/svc', env: {} } })
    await expect(
      unknownDistro.invoke({
        serviceId: 'demo.svc',
        worktree: { worktreeId: 'wt', path: '\\\\wsl$\\Gone\\home\\u\\wt' },
        request: null
      })
    ).rejects.toMatchObject({ code: 'distro-unavailable' })
    await unknownDistro.dispose()
  })

  it('reports unknown services without leaking host facts', async () => {
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux' })
    const failure = await execution
      .invoke({
        serviceId: 'demo.missing',
        worktree: { worktreeId: 'wt', path: '/tmp/wt' },
        request: null
      })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ServiceExecutionError)
    expect((failure as ServiceExecutionError).code).toBe('service-unavailable')
    expect(String((failure as Error).message)).not.toContain('/tmp')
    await execution.dispose()
  })

  it('times out a hung service and recycles the child', async () => {
    let spawns = 0
    const fakeSpawn = (() => {
      spawns += 1
      return createFakeChild(() => {}) as unknown as ReturnType<typeof spawnProcess>
    }) as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register(nativeEchoDefinition('demo.hang', undefined, { requestTimeoutMs: 40 }))
    await expect(
      execution.invoke({
        serviceId: 'demo.hang',
        worktree: { worktreeId: 'wt', path: '/tmp/wt' },
        request: null
      })
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(spawns).toBe(1)
    // Next invoke restarts deterministically instead of reusing the hung child.
    const hanging = execution.invoke({
      serviceId: 'demo.hang',
      worktree: { worktreeId: 'wt', path: '/tmp/wt' },
      request: null
    })
    await expect(hanging).rejects.toMatchObject({ code: 'timeout' })
    expect(spawns).toBe(2)
    await execution.dispose()
  })

  it('cancels one caller while keeping the sidecar alive for others', async () => {
    const fakeSpawn = (() => {
      let spawns = 0
      const spawn = ((spec: unknown) => {
        spawns += 1
        void spec
        void spawns
        return createFakeChild((line, child) => {
          const msg = JSON.parse(line) as { id: string; request: unknown }
          if ((msg.request as { op?: string })?.op === 'slow') {
            return
          }
          queueMicrotask(() =>
            child.stdout.emit('data', `${JSON.stringify({ id: msg.id, response: { ok: true } })}\n`)
          )
        }) as unknown as ReturnType<typeof spawnProcess>
      }) as unknown as typeof spawnProcess
      return spawn
    })() as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register(nativeEchoDefinition('demo.cancel'))
    const controller = new AbortController()
    const cancelled = execution.invoke({
      serviceId: 'demo.cancel',
      worktree: { worktreeId: 'wt', path: '/tmp/wt' },
      request: { op: 'slow' },
      signal: controller.signal
    })
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
    // Same sidecar still answers the next request without a restart.
    const next = (await execution.invoke({
      serviceId: 'demo.cancel',
      worktree: { worktreeId: 'wt', path: '/tmp/wt' },
      request: { op: 'fast' }
    })) as { ok: boolean }
    expect(next).toEqual({ ok: true })
    await execution.dispose()
  })

  it('restarts a crashed service deterministically', async () => {
    let spawns = 0
    let crashedChild: FakeChild | null = null
    const fakeSpawn = (() => {
      spawns += 1
      const child = createFakeChild(echoOnWrite((request) => ({ echo: request })))
      if (spawns === 1) {
        crashedChild = child
      }
      return child as unknown as ReturnType<typeof spawnProcess>
    }) as unknown as typeof spawnProcess as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register(nativeEchoDefinition('demo.flaky'))
    await expect(
      execution.invoke({
        serviceId: 'demo.flaky',
        worktree: { worktreeId: 'wt', path: '/tmp/wt' },
        request: { n: 1 }
      })
    ).resolves.toEqual({ echo: { n: 1 } })
    ;(crashedChild as unknown as EventEmitter | null)?.emit('exit', 1, null)
    await expect(
      execution.invoke({
        serviceId: 'demo.flaky',
        worktree: { worktreeId: 'wt', path: '/tmp/wt' },
        request: { n: 2 }
      })
    ).resolves.toEqual({ echo: { n: 2 } })
    expect(spawns).toBe(2)
    await execution.dispose()
  })

  it('rejects malformed service output without leaking bytes', async () => {
    const fakeSpawn = (() =>
      createFakeChild((_line, child) => {
        queueMicrotask(() => child.stdout.emit('data', 'not-json\n'))
      }) as unknown as ReturnType<typeof spawnProcess>) as unknown as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register(nativeEchoDefinition('demo.broken'))
    const failure = await execution
      .invoke({
        serviceId: 'demo.broken',
        worktree: { worktreeId: 'wt', path: '/tmp/wt' },
        request: null
      })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'malformed-response' })
    expect(String((failure as Error).message)).not.toContain('not-json')
    await execution.dispose()
  })

  it('isolates two worktrees onto independent sidecars', async () => {
    let spawns = 0
    const children = new Map<string, FakeChild>()
    const fakeSpawn = ((spec: { cwd?: string }) => {
      spawns += 1
      const cwd = spec.cwd ?? `anon-${spawns}`
      const child = createFakeChild(echoOnWrite((request) => ({ echo: request, owner: cwd })))
      children.set(cwd, child)
      return child as unknown as ReturnType<typeof spawnProcess>
    }) as unknown as typeof spawnProcess as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register(nativeEchoDefinition('demo.iso'))
    const worktreeA = { worktreeId: 'wt-a', path: '/tmp/wt-a' }
    const worktreeB = { worktreeId: 'wt-b', path: '/tmp/wt-b' }
    const [responseA, responseB] = await Promise.all([
      execution.invoke({ serviceId: 'demo.iso', worktree: worktreeA, request: { from: 'a' } }),
      execution.invoke({ serviceId: 'demo.iso', worktree: worktreeB, request: { from: 'b' } })
    ])
    expect(responseA).toEqual({ echo: { from: 'a' }, owner: '/tmp/wt-a' })
    expect(responseB).toEqual({ echo: { from: 'b' }, owner: '/tmp/wt-b' })
    expect(spawns).toBe(2)
    // Crashing A restarts only A; B keeps its child.
    children.get('/tmp/wt-a')?.emit('exit', 1, null)
    await expect(
      execution.invoke({ serviceId: 'demo.iso', worktree: worktreeA, request: { from: 'a2' } })
    ).resolves.toEqual({ echo: { from: 'a2' }, owner: '/tmp/wt-a' })
    expect(spawns).toBe(3)
    await expect(
      execution.invoke({ serviceId: 'demo.iso', worktree: worktreeB, request: { from: 'b2' } })
    ).resolves.toEqual({ echo: { from: 'b2' }, owner: '/tmp/wt-b' })
    expect(spawns).toBe(3)
    await execution.dispose()
  })

  it('derives runtime placement from trusted worktree state', () => {
    expect(
      resolveServiceWorktreeRuntime({ worktreeId: 'wt', path: '/tmp/wt' }, { platform: 'linux' })
    ).toMatchObject({ kind: 'native' })
    expect(() =>
      resolveServiceWorktreeRuntime({ worktreeId: '', path: '/tmp/wt' }, { platform: 'linux' })
    ).toThrow()
  })
})
