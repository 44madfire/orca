import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { PluginServiceRuntimeExecution } from './plugin-service-runtime-execution'
import { createWslGuestHandle, type WslGuestHandle } from './plugin-service-wsl-guest'
import type { CrashedTreeRoot } from './plugin-service-crashed-tree-sweep'
import type { PluginServiceSidecarDeps } from './plugin-service-sidecar-transport'

// Guest-side WSL ownership (ORCA-UI1.2 round 9): the wsl.exe wrapper can be
// adopted away by wslhost, so teardown must own the Linux pid directly.

type FakeChild = EventEmitter & {
  pid: number
  exitCode: number | null
  signalCode: null
  stdin: EventEmitter & { write: (line: string) => boolean }
  stdout: EventEmitter
  stderr: EventEmitter
  kill: () => boolean
}

function createFakeChild(onWrite: (line: string, child: FakeChild) => void): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = 3000 + Math.floor(Math.random() * 50000)
  child.exitCode = null
  child.signalCode = null
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
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

function scriptedGuest(log: string[][], alive: () => boolean) {
  return async (argv: readonly string[]): Promise<number | null> => {
    log.push([...argv])
    const script = argv.join(' ')
    if (script.includes('kill -KILL')) {
      return 0
    }
    return alive() ? 0 : 1
  }
}

describe('wsl guest sidecar ownership', () => {
  it('wraps the guest command with a pid marker and observes it', () => {
    const guest = createWslGuestHandle('Ubuntu')
    const argv = guest.wrapGuestCommand({
      cwd: '/home/u/wt',
      env: { BRIDGE_MODE: 'rpc' },
      command: '/usr/local/bin/demo-bridge',
      args: ['--serve']
    })
    expect(argv[0]).toBe('sh')
    const script = argv[2] ?? ''
    expect(script).toContain('setsid --wait true')
    expect(script).toContain('/home/u/wt')
    expect(script).toContain('/usr/local/bin/demo-bridge')
    expect(guest.guestPid()).toBeNull()
    guest.observeStderr(Buffer.from('motd noise\n'))
    expect(guest.guestPid()).toBeNull()
    const marker = script.match(/__ORCA_SIDECAR_GUEST_[A-Za-z0-9]+/)?.[0]
    expect(marker).toBeTruthy()
    guest.observeStderr(`${marker}_SETSID_4242\n`)
    expect(guest.guestPid()).toBe(4242)
  })

  it('retires the observed guest and verifies absence', async () => {
    const log: string[][] = []
    let alive = true
    const guest = createWslGuestHandle('Ubuntu', { runGuest: scriptedGuest(log, () => alive) })
    const script = guest
      .wrapGuestCommand({ cwd: '/home/u/wt', env: {}, command: '/bin/svc', args: [] })
      .join(' ')
    const marker = script.match(/__ORCA_SIDECAR_GUEST_[A-Za-z0-9]+/)?.[0]
    expect(marker).toBeTruthy()
    guest.observeStderr(`${marker}_SETSID_4242\n`)
    expect(guest.guestPid()).toBe(4242)
    await expect(guest.retire()).resolves.toBe(false)
    expect(log.some((argv) => argv.join(' ').includes('-4242'))).toBe(true)
    alive = false
    await expect(guest.retire()).resolves.toBe(true)
  })

  it('reports nothing to own when the marker never arrived', async () => {
    let calls = 0
    const guest = createWslGuestHandle('Ubuntu', {
      runGuest: async () => {
        calls += 1
        return 0
      }
    })
    await expect(guest.retire()).resolves.toBe(true)
    expect(calls).toBe(0)
  })

  it('holds teardown open while the guest outlives its wrapper', async () => {
    let guestAlive = true
    let guestRetires = 0
    const guest: WslGuestHandle = {
      distro: 'Ubuntu',
      wrapGuestCommand: (input) => ['sh', '-c', `cd-stub ${input.cwd}`],
      observeStderr: () => undefined,
      guestPid: () => 4242,
      retire: async () => {
        guestRetires += 1
        return !guestAlive
      }
    }
    const children: FakeChild[] = []
    const fakeSpawn = (() => {
      const child = createFakeChild(echoOnWrite((request) => ({ echo: request })))
      children.push(child)
      return child as unknown as ReturnType<typeof spawnProcess>
    }) as unknown as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({
      platform: 'win32',
      runtimeProbe: {
        platform: 'win32',
        parseWslUncPath: () => ({ distro: 'Ubuntu', linuxPath: '/home/u/wt' }),
        isWslAvailable: () => true,
        listWslDistros: () => ['Ubuntu']
      },
      spawnImpl: fakeSpawn,
      wslGuest: guest
    })
    execution.register({
      serviceId: 'demo.wsl-guest',
      launch: { command: '/usr/local/bin/demo-bridge', args: [], env: {} },
      limits: { terminateImpl: fakeTerminate, sweepCrashedTreeImpl: async () => true }
    })
    const worktree = { worktreeId: 'wt', path: UNC }
    await expect(
      execution.invoke({ serviceId: 'demo.wsl-guest', worktree, request: null })
    ).resolves.toEqual({ echo: null })
    const wrapper = children[0]
    expect(wrapper).toBeDefined()
    if (wrapper) {
      wrapper.exitCode = 1
      wrapper.emit('exit', 1, null)
    }
    // Wrapper is gone but the guest lives: teardown must not report success.
    await expect(execution.closeScope('demo.wsl-guest', worktree)).rejects.toMatchObject({
      code: 'teardown-unverified'
    })
    expect(guestRetires).toBeGreaterThanOrEqual(1)
    guestAlive = false
    await execution.closeScope('demo.wsl-guest', worktree)
    await execution.dispose()
  })

  it('cleans a startup-grace exit once late identity arrives', async () => {
    const seen: CrashedTreeRoot[] = []
    let releaseIdentity!: (ms: number | null) => void
    const identityGate = new Promise<number | null>((resolve) => {
      releaseIdentity = resolve
    })
    const children: FakeChild[] = []
    const fakeSpawn = (() => {
      if (children.length > 0) {
        return createFakeChild(
          echoOnWrite((request) => ({ echo: request }))
        ) as unknown as ReturnType<typeof spawnProcess>
      }
      const failing = createFakeChild(() => {})
      children.push(failing)
      queueMicrotask(() => {
        failing.exitCode = 1
        failing.emit('exit', 1, null)
      })
      return failing as unknown as ReturnType<typeof spawnProcess>
    }) as unknown as typeof spawnProcess
    const execution = new PluginServiceRuntimeExecution({ platform: 'linux', spawnImpl: fakeSpawn })
    execution.register({
      serviceId: 'demo.grace-identity',
      launch: { command: '/opt/host-owned/bridge', args: [], env: {} },
      limits: {
        terminateImpl: fakeTerminate,
        readRootCreationTime: () => identityGate,
        sweepCrashedTreeImpl: (async (root: CrashedTreeRoot) => {
          seen.push({ ...root })
          return root.creationTimeMs !== null
        }) as unknown as PluginServiceSidecarDeps['sweepCrashedTreeImpl']
      }
    })
    const worktree = { worktreeId: 'wt', path: '/tmp/wt' }
    await expect(
      execution.invoke({ serviceId: 'demo.grace-identity', worktree, request: null })
    ).rejects.toMatchObject({ code: 'start-failed' })
    releaseIdentity(4242)
    // The retired victim is enriched; a later redrive proves what the first
    // attempt could not, so teardown succeeds instead of failing forever.
    // (The first redrive may still race ahead of the enrichment microtask
    // with a null identity; convergence is what matters.)
    await execution.dispose()
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.at(0)?.creationTimeMs).toBeNull()
    expect(seen.at(-1)?.creationTimeMs).toBe(4242)
  })
})
