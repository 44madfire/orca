import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import { ServiceExecutionError } from './plugin-service-execution-errors'
import type { RegisteredSidecarService, SidecarLaunch } from './plugin-service-sidecar-spec'
import { ServiceSidecarController } from './plugin-service-sidecar-lifecycle'

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
const BLACKHOLE_SCRIPT = 'setInterval(()=>{},1000);'
const EXIT_SCRIPT = 'process.exit(3);'

function echoLaunch(script: string = ECHO_SCRIPT): SidecarLaunch {
  return { program: process.execPath, args: ['-e', script], env: { ...process.env } }
}

function registration(limits?: RegisteredSidecarService['limits']): RegisteredSidecarService {
  return { serviceId: 'svc.echo', buildLaunch: () => echoLaunch(), limits }
}

const NATIVE_RUNTIME = { kind: 'native', worktreeId: 'wt-a', worktreePath: '/repo' } as const

function nativeController(
  limits?: RegisteredSidecarService['limits'],
  spawnImpl?: (spec: ProcessSpec) => SpawnedProcess
): ServiceSidecarController {
  return new ServiceSidecarController(
    'svc.echo',
    { ...NATIVE_RUNTIME },
    echoLaunch(),
    registration(limits),
    {
      spawnImpl,
      ownership: { verifyPollMs: 10, verifyDeadlineMs: 3000 }
    }
  )
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'EPERM'
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return '<resolved>'
  } catch (error) {
    return error instanceof ServiceExecutionError ? error.code : `<wrong:${String(error)}>`
  }
}

describe('native sidecar lifecycle', () => {
  it('invokes a structured request and reuses the generation', async () => {
    const spawns: ProcessSpec[] = []
    const controller = nativeController(undefined, (spec) => {
      spawns.push(spec)
      return spawnProcess(spec)
    })
    try {
      expect(await controller.invoke({ hello: 'world' })).toEqual({ hello: 'world' })
      expect(await controller.invoke([1, 2])).toEqual([1, 2])
      expect(spawns).toHaveLength(1)
    } finally {
      await controller.dispose()
    }
  })

  it('reports start-failed when the sidecar cannot be spawned', async () => {
    const controller = nativeController(undefined, () => {
      throw new Error('spawn ENOENT with host path facts')
    })
    try {
      const error = await controller.invoke({}).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(ServiceExecutionError)
      expect((error as ServiceExecutionError).code).toBe('start-failed')
      // Redacted: the raw spawn error (paths) never reaches the caller.
      expect((error as Error).message).not.toContain('ENOENT')
    } finally {
      await controller.dispose()
    }
  })

  it('reports crashed when the sidecar exits instead of answering', async () => {
    const controller = new ServiceSidecarController(
      'svc.echo',
      { ...NATIVE_RUNTIME },
      echoLaunch(EXIT_SCRIPT),
      registration(),
      { ownership: { verifyPollMs: 10, verifyDeadlineMs: 3000 } }
    )
    try {
      // Native sidecars are ready at spawn; an exit before the first
      // response is a crash, and the next invoke restarts deterministically.
      expect(await codeOf(controller.invoke({}))).toBe('crashed')
    } finally {
      await controller.dispose()
    }
  })

  it('times out a hung request without killing the sidecar', async () => {
    const controller = new ServiceSidecarController(
      'svc.echo',
      { ...NATIVE_RUNTIME },
      echoLaunch(BLACKHOLE_SCRIPT),
      registration({ requestTimeoutMs: 100 }),
      { ownership: { verifyPollMs: 10, verifyDeadlineMs: 3000 } }
    )
    try {
      expect(await codeOf(controller.invoke({}))).toBe('timeout')
    } finally {
      await controller.dispose()
    }
  })

  it('cancels a hung request on abort', async () => {
    const controller = new ServiceSidecarController(
      'svc.echo',
      { ...NATIVE_RUNTIME },
      echoLaunch(BLACKHOLE_SCRIPT),
      registration(),
      { ownership: { verifyPollMs: 10, verifyDeadlineMs: 3000 } }
    )
    try {
      const abort = new AbortController()
      const pending = controller.invoke({}, { signal: abort.signal })
      setTimeout(() => abort.abort(), 50)
      expect(await codeOf(pending)).toBe('cancelled')
    } finally {
      await controller.dispose()
    }
  })

  it('fails fast when overloaded', async () => {
    const controller = new ServiceSidecarController(
      'svc.echo',
      { ...NATIVE_RUNTIME },
      echoLaunch(BLACKHOLE_SCRIPT),
      registration({ maxPendingRequests: 1 }),
      { ownership: { verifyPollMs: 10, verifyDeadlineMs: 3000 } }
    )
    try {
      const first = controller.invoke({})
      first.catch(() => undefined)
      expect(await codeOf(controller.invoke({}))).toBe('overloaded')
      await controller.dispose()
      expect(await codeOf(first)).toBe('cancelled')
    } finally {
      await controller.dispose()
    }
  })

  it('restarts deterministically after a crash: exactly one new generation', async () => {
    let calls = 0
    const controller = nativeController(undefined, (spec) => {
      calls += 1
      const script = calls === 1 ? EXIT_SCRIPT : ECHO_SCRIPT
      return spawnProcess({ ...spec, args: ['-e', script] })
    })
    try {
      expect(await codeOf(controller.invoke({}))).toBe('crashed')
      expect(calls).toBe(1)
      expect(await controller.invoke({ n: 1 })).toEqual({ n: 1 })
      expect(calls).toBe(2)
    } finally {
      await controller.dispose()
    }
  })

  it('dispose tears the tree down: no orphan process survives', async () => {
    const children: SpawnedProcess[] = []
    const controller = nativeController(undefined, (spec) => {
      const child = spawnProcess(spec)
      children.push(child)
      return child
    })
    expect(await controller.invoke({})).toEqual({})
    const pid = children[0].pid
    expect(pid).toBeDefined()
    await controller.dispose()
    await waitFor(() => isDead(pid!))
  })

  it('two worktree scopes never share a sidecar', async () => {
    const a = nativeController()
    const b = new ServiceSidecarController(
      'svc.echo',
      { kind: 'native', worktreeId: 'wt-b', worktreePath: '/repo-b' },
      echoLaunch(),
      registration(),
      { ownership: { verifyPollMs: 10, verifyDeadlineMs: 3000 } }
    )
    try {
      expect(await a.invoke({ from: 'a' })).toEqual({ from: 'a' })
      expect(await b.invoke({ from: 'b' })).toEqual({ from: 'b' })
      await a.dispose()
      // B's context is untouched by A's teardown.
      expect(await b.invoke({ again: true })).toEqual({ again: true })
    } finally {
      await a.dispose()
      await b.dispose()
    }
  })
})

// Fake wsl.exe child: the test plays the supervisor + service.
type FakeWslChild = SpawnedProcess & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  spec: ProcessSpec
  closeWith: (code: number | null) => void
}

function makeFakeWslChild(spec: ProcessSpec, pid: number): FakeWslChild {
  const emitter = new EventEmitter()
  const child = emitter as unknown as FakeWslChild
  Object.defineProperty(child, 'pid', { value: pid, configurable: true })
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.spec = spec
  child.kill = () => {
    setImmediate(() => emitter.emit('close', null, null))
    return true
  }
  child.closeWith = (code) => {
    setImmediate(() => emitter.emit('close', code, null))
  }
  return child
}

function nonceOf(spec: ProcessSpec): string {
  // The lease travels at exec time through env(1), never as a bare word.
  const pair = spec.args?.find(
    (arg) => typeof arg === 'string' && arg.startsWith('ORCA_SIDECAR_NONCE=')
  )
  if (!pair) {
    throw new Error('fake wsl child saw no supervisor nonce')
  }
  return pair.slice('ORCA_SIDECAR_NONCE='.length)
}

const WSL_RUNTIME = {
  kind: 'wsl',
  worktreeId: 'wt-w',
  worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\you\\repo',
  distro: 'Ubuntu',
  linuxPath: '/home/you/repo'
} as const

// Fake guest filesystem mirroring verifyGuestProcessNonce's protocol:
// `test -d` probes existence, `cat` probes readability + content.
function fakeGuestRunner(
  owned: Map<number, string>,
  onVerify?: (pid: number) => void,
  opts?: { present?: Set<number>; unreadable?: Set<number> }
): (
  distro: string
) => (args: readonly string[]) => Promise<{ code: number | null; stdout: string }> {
  // Lookups stay live on `owned`: tests populate it when the fake supervisor
  // reports, which is after this runner is constructed.
  const isPresent = (pid: number): boolean => (opts?.present ?? owned).has(pid)
  const isReadable = (pid: number): boolean => !opts?.unreadable?.has(pid) && owned.has(pid)
  return () => async (args) => {
    if (args[0] === 'test') {
      const dir = args[2] ?? ''
      if (dir === '/proc') {
        return { code: 0, stdout: '' }
      }
      const pid = Number(/^\/proc\/(\d+)$/.exec(dir)?.[1])
      onVerify?.(pid)
      return { code: isPresent(pid) ? 0 : 1, stdout: '' }
    }
    const pid = Number(/^\/proc\/(\d+)\/environ$/.exec(args[1] ?? '')?.[1])
    onVerify?.(pid)
    if (!isReadable(pid)) {
      return { code: 1, stdout: '' }
    }
    const nonce = owned.get(pid)
    return { code: 0, stdout: `PATH=/usr/bin\0ORCA_SIDECAR_NONCE=${nonce ?? '?'}\0` }
  }
}

function wslController(
  onSpawn: (child: FakeWslChild) => void,
  limits?: RegisteredSidecarService['limits'],
  extra?: {
    ownedGuests?: Map<number, string>
    unreadableGuests?: Set<number>
    onVerify?: (pid: number) => void
    runnerImpl?: (
      distro: string
    ) => (args: readonly string[]) => Promise<{ code: number | null; stdout: string }>
    sweepImpl?: (distro: string, argv: readonly string[]) => Promise<boolean>
    sweeps?: { distro: string; argv: readonly string[] }[]
    launchEnv?: Record<string, string>
  }
): { controller: ServiceSidecarController; children: FakeWslChild[] } {
  const children: FakeWslChild[] = []
  let pid = 5000
  const owned = extra?.ownedGuests ?? new Map<number, string>()
  const controller = new ServiceSidecarController(
    'svc.wsl',
    { ...WSL_RUNTIME },
    { program: '/usr/bin/svc', args: ['--serve'], env: extra?.launchEnv },
    { serviceId: 'svc.wsl', buildLaunch: () => null, limits },
    {
      platform: 'win32',
      spawnImpl: (spec) => {
        const child = makeFakeWslChild(spec, pid++)
        children.push(child)
        onSpawn(child)
        return child
      },
      ownership: {
        readCreationTimeMs: async () => null,
        isPidAlive: () => false,
        terminateTree: async () => true
      },
      guestRunnerImpl:
        extra?.runnerImpl ??
        fakeGuestRunner(owned, extra?.onVerify, { unreadable: extra?.unreadableGuests }),
      sweepGuestImpl: async (distro, argv) => {
        extra?.sweeps?.push({ distro, argv })
        return extra?.sweepImpl ? extra.sweepImpl(distro, argv) : true
      }
    }
  )
  return { controller, children }
}

// Responder that leaves `hold` requests in-flight so a crash lands on a
// live request; awaiting its failure proves crash processing finished.
function holdableResponder(child: FakeWslChild): void {
  let buffer = ''
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += String(chunk)
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) {
        continue
      }
      const msg = JSON.parse(line) as { id: string; params: unknown }
      if ((msg.params as { hold?: boolean } | null)?.hold === true) {
        continue
      }
      child.stdout.write(`${JSON.stringify({ id: msg.id, result: msg.params })}\n`)
    }
  })
}

function answerRequests(child: FakeWslChild): void {
  let buffer = ''
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += String(chunk)
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) {
        continue
      }
      const msg = JSON.parse(line) as { id: string; params: unknown }
      child.stdout.write(`${JSON.stringify({ id: msg.id, result: msg.params })}\n`)
    }
  })
}

describe('wsl sidecar lifecycle', () => {
  it('spawns through wsl.exe --exec and binds readiness to the nonce READY', async () => {
    const { controller, children } = wslController((child) => {
      answerRequests(child)
      const nonce = nonceOf(child.spec)
      child.stdout.write(`ORCA_SIDECAR_READY pid=100 nonce=${nonce}\n`)
      child.stdout.write(`ORCA_SIDECAR_CHILD pid=101 nonce=${nonce}\n`)
    })
    try {
      expect(await controller.invoke({ hello: 1 })).toEqual({ hello: 1 })
      expect(children).toHaveLength(1)
      expect(children[0].spec.program).toBe('wsl.exe')
      expect(children[0].spec.args).toContain('--exec')
      expect(children[0].spec.args?.join(' ')).not.toContain('-ilc')
      // Lease at exec time through env(1): what /proc environ can prove.
      const guestArgv = children[0].spec.args ?? []
      const envIndex = guestArgv.indexOf('/usr/bin/env')
      expect(envIndex).toBeGreaterThanOrEqual(0)
      expect(guestArgv[envIndex + 1]).toMatch(/^ORCA_SIDECAR_NONCE=[A-Za-z0-9_-]+$/)
    } finally {
      await controller.dispose()
    }
  })

  it('carries the registered environment into the guest spawn', async () => {
    const { controller, children } = wslController(
      (child) => {
        const nonce = nonceOf(child.spec)
        answerRequests(child)
        child.stdout.write(`ORCA_SIDECAR_READY pid=100 nonce=${nonce}\n`)
      },
      undefined,
      { launchEnv: { FOO_REQ: 'req-value' } }
    )
    try {
      expect(await controller.invoke({ ping: 1 })).toEqual({ ping: 1 })
      const guestArgv = children[0].spec.args ?? []
      expect(guestArgv).toContain('-i')
      expect(guestArgv).toContain('FOO_REQ=req-value')
    } finally {
      await controller.dispose()
    }
  })

  it('ignores a stale generation READY and fails startup on grace expiry', async () => {
    const kills: string[] = []
    const { controller, children } = wslController(
      (child) => {
        const innerKill = child.kill.bind(child)
        child.kill = (...args: []) => {
          kills.push('root-kill')
          return innerKill(...args)
        }
        child.stdout.write('ORCA_SIDECAR_READY pid=100 nonce=stale-nonce\n')
      },
      { startupGraceMs: 100 }
    )
    try {
      expect(await codeOf(controller.invoke({}))).toBe('start-failed')
      expect(children).toHaveLength(1)
      // The failed startup tears the half-started wrapper down instead of
      // leaking it behind the start-failed report.
      expect(kills).not.toEqual([])
    } finally {
      await controller.dispose()
    }
  })

  it('a wrapper crash fails in-flight requests and restarts on next invoke', async () => {
    const { controller, children } = wslController((child) => {
      const nonce = nonceOf(child.spec)
      child.stdout.write(`ORCA_SIDECAR_READY pid=100 nonce=${nonce}\n`)
      let buffer = ''
      child.stdin.on('data', (chunk: Buffer) => {
        buffer += String(chunk)
        let index: number
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (!line.trim()) {
            continue
          }
          const msg = JSON.parse(line) as { id: string; params: unknown }
          // `hold` stays in-flight so the crash lands on a live request.
          if ((msg.params as { hold?: boolean } | null)?.hold === true) {
            continue
          }
          child.stdout.write(`${JSON.stringify({ id: msg.id, result: msg.params })}\n`)
        }
      })
    })
    try {
      // The answered ping proves the generation is ready before the crash.
      expect(await controller.invoke({ ping: 1 })).toEqual({ ping: 1 })
      const pending = controller.invoke({ hold: true })
      pending.catch(() => undefined)
      children[0].closeWith(1)
      expect(await codeOf(pending)).toBe('crashed')
      // Deterministic restart: the next invoke spawns exactly one new wrapper.
      expect(await controller.invoke({ after: 'crash' })).toEqual({ after: 'crash' })
      expect(children).toHaveLength(2)
    } finally {
      await controller.dispose()
    }
  })

  it('a wrapper crash reaps the orphaned guest before restart, verified first', async () => {
    const events: string[] = []
    const sweeps: { distro: string; argv: readonly string[] }[] = []
    const owned = new Map<number, string>()
    let spawns = 0
    const { controller, children } = wslController(
      (child) => {
        spawns += 1
        events.push(`spawn${spawns}`)
        const nonce = nonceOf(child.spec)
        if (spawns === 1) {
          owned.set(100, nonce)
          owned.set(101, nonce)
        }
        holdableResponder(child)
        child.stdout.write(`ORCA_SIDECAR_READY pid=100 nonce=${nonce}\n`)
        child.stdout.write(`ORCA_SIDECAR_CHILD pid=101 nonce=${nonce}\n`)
      },
      undefined,
      {
        ownedGuests: owned,
        sweeps,
        onVerify: (pid) => events.push(`verify:${pid}`),
        // The helper records the script; here only the ordering event matters.
        sweepImpl: async () => {
          events.push('sweep')
          return true
        }
      }
    )
    try {
      expect(await controller.invoke({ ping: 1 })).toEqual({ ping: 1 })
      const pending = controller.invoke({ hold: true })
      pending.catch(() => undefined)
      children[0].closeWith(1)
      expect(await codeOf(pending)).toBe('crashed')
      // Restart reaps the lost guest first: verify, then sweep, then respawn.
      expect(await controller.invoke({ after: 'crash' })).toEqual({ after: 'crash' })
      expect(children).toHaveLength(2)
      expect(sweeps).toHaveLength(1)
      const expectedNonce = nonceOf(children[0].spec)
      expect(sweeps[0].argv).toContain(expectedNonce)
      expect(sweeps[0].argv.slice(-2)).toEqual(['100', '101'])
      const order = events.filter(
        (event) => event.startsWith('verify:') || event === 'sweep' || event.startsWith('spawn')
      )
      // Existence then content per pid, both before the sweep.
      expect(order).toEqual([
        'spawn1',
        'verify:100',
        'verify:100',
        'verify:101',
        'verify:101',
        'sweep',
        'spawn2'
      ])
    } finally {
      await controller.dispose()
    }
  })

  it('recycled guest pids are never signaled', async () => {
    const sweeps: { distro: string; argv: readonly string[] }[] = []
    const { controller, children } = wslController(
      (child) => {
        const nonce = nonceOf(child.spec)
        holdableResponder(child)
        child.stdout.write(`ORCA_SIDECAR_READY pid=100 nonce=${nonce}\n`)
        child.stdout.write(`ORCA_SIDECAR_CHILD pid=101 nonce=${nonce}\n`)
      },
      undefined,
      { sweeps }
    )
    try {
      expect(await controller.invoke({ ping: 1 })).toEqual({ ping: 1 })
      const pending = controller.invoke({ hold: true })
      pending.catch(() => undefined)
      children[0].closeWith(1)
      expect(await codeOf(pending)).toBe('crashed')
      // Both pids recycled (no /proc entry): nothing to kill, restart proceeds.
      expect(await controller.invoke({ after: 'crash' })).toEqual({ after: 'crash' })
      expect(children).toHaveLength(2)
      expect(sweeps).toEqual([])
    } finally {
      await controller.dispose()
    }
  })

  it('unknown guest identity fails restart as teardown-unverified', async () => {
    const { controller, children } = wslController(
      (child) => {
        const nonce = nonceOf(child.spec)
        holdableResponder(child)
        child.stdout.write(`ORCA_SIDECAR_READY pid=100 nonce=${nonce}\n`)
      },
      undefined,
      {
        runnerImpl: () => async () => {
          throw new Error('wsl.exe transport down')
        }
      }
    )
    try {
      expect(await controller.invoke({ ping: 1 })).toEqual({ ping: 1 })
      const pending = controller.invoke({ hold: true })
      pending.catch(() => undefined)
      children[0].closeWith(1)
      expect(await codeOf(pending)).toBe('crashed')
      // Identity unreadable: no kill is attempted, no replacement starts.
      expect(await codeOf(controller.invoke({ after: 'crash' }))).toBe('teardown-unverified')
      expect(children).toHaveLength(1)
    } finally {
      await controller.dispose().catch(() => undefined)
    }
  })

  it('a failed guest sweep fails restart as teardown-unverified', async () => {
    const owned = new Map<number, string>()
    const { controller, children } = wslController(
      (child) => {
        const nonce = nonceOf(child.spec)
        owned.set(100, nonce)
        holdableResponder(child)
        child.stdout.write(`ORCA_SIDECAR_READY pid=100 nonce=${nonce}\n`)
      },
      undefined,
      {
        ownedGuests: owned,
        sweepImpl: async () => false
      }
    )
    try {
      expect(await controller.invoke({ ping: 1 })).toEqual({ ping: 1 })
      const pending = controller.invoke({ hold: true })
      pending.catch(() => undefined)
      children[0].closeWith(1)
      expect(await codeOf(pending)).toBe('crashed')
      expect(await codeOf(controller.invoke({ after: 'crash' }))).toBe('teardown-unverified')
      expect(children).toHaveLength(1)
    } finally {
      await controller.dispose().catch(() => undefined)
    }
  })

  it('dispose sweeps a crash-orphaned guest', async () => {
    const sweeps: { distro: string; argv: readonly string[] }[] = []
    const owned = new Map<number, string>()
    const { controller, children } = wslController(
      (child) => {
        const nonce = nonceOf(child.spec)
        owned.set(100, nonce)
        holdableResponder(child)
        child.stdout.write(`ORCA_SIDECAR_READY pid=100 nonce=${nonce}\n`)
      },
      undefined,
      { ownedGuests: owned, sweeps }
    )
    try {
      expect(await controller.invoke({ ping: 1 })).toEqual({ ping: 1 })
      const pending = controller.invoke({ hold: true })
      pending.catch(() => undefined)
      children[0].closeWith(1)
      expect(await codeOf(pending)).toBe('crashed')
      await controller.dispose()
      expect(sweeps).toHaveLength(1)
      expect(sweeps[0].argv.slice(-3)).toEqual([nonceOf(children[0].spec), '100', ''])
    } finally {
      await controller.dispose()
    }
  })

  it('a crash between READY and CHILD still reaps the supervisor', async () => {
    const sweeps: { distro: string; argv: readonly string[] }[] = []
    const owned = new Map<number, string>()
    const { controller, children } = wslController(
      (child) => {
        const nonce = nonceOf(child.spec)
        owned.set(100, nonce)
        holdableResponder(child)
        // No CHILD line: the wrapper dies in the READY-before-CHILD window.
        child.stdout.write(`ORCA_SIDECAR_READY pid=100 nonce=${nonce}\n`)
      },
      undefined,
      { ownedGuests: owned, sweeps }
    )
    try {
      expect(await controller.invoke({ ping: 1 })).toEqual({ ping: 1 })
      const pending = controller.invoke({ hold: true })
      pending.catch(() => undefined)
      children[0].closeWith(1)
      expect(await codeOf(pending)).toBe('crashed')
      expect(await controller.invoke({ after: 'crash' })).toEqual({ after: 'crash' })
      expect(children).toHaveLength(2)
      // Only the proven supervisor pid is signaled.
      expect(sweeps).toHaveLength(1)
      expect(sweeps[0].argv.slice(-3)).toEqual([nonceOf(children[0].spec), '100', ''])
    } finally {
      await controller.dispose()
    }
  })

  it('aborting during startup cancels instead of hanging on readiness', async () => {
    const startedAt = Date.now()
    const { controller } = wslController(() => undefined, { startupGraceMs: 3000 })
    try {
      const abort = new AbortController()
      const pending = controller.invoke({}, { signal: abort.signal })
      pending.catch(() => undefined)
      setTimeout(() => abort.abort(), 50)
      // Cancelled promptly: never waits out the startup grace.
      expect(await codeOf(pending)).toBe('cancelled')
      expect(Date.now() - startedAt).toBeLessThan(2500)
    } finally {
      await controller.dispose()
    }
  })

  it('an unreadable live identity refuses the kill as teardown-unverified', async () => {
    // EACCES-shaped guest: the /proc entry exists but environ is locked.
    const owned = new Map<number, string>()
    const { controller, children } = wslController(
      (child) => {
        const nonce = nonceOf(child.spec)
        owned.set(100, nonce)
        holdableResponder(child)
        child.stdout.write(`ORCA_SIDECAR_READY pid=100 nonce=${nonce}\n`)
      },
      undefined,
      { ownedGuests: owned, unreadableGuests: new Set([100]) }
    )
    try {
      expect(await controller.invoke({ ping: 1 })).toEqual({ ping: 1 })
      const pending = controller.invoke({ hold: true })
      pending.catch(() => undefined)
      children[0].closeWith(1)
      expect(await codeOf(pending)).toBe('crashed')
      // Alive as far as anyone can prove: no kill, no replacement.
      expect(await codeOf(controller.invoke({ after: 'crash' }))).toBe('teardown-unverified')
      expect(children).toHaveLength(1)
    } finally {
      await controller.dispose().catch(() => undefined)
    }
  })

  it('stop during startup settles the starter instead of stranding it', async () => {
    const { controller } = wslController(() => undefined, { startupGraceMs: 5000 })
    const pending = controller.invoke({})
    pending.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await controller.stop()
    // The starter cannot hang: the torn-down startup reports start-failed.
    expect(await codeOf(pending)).toBe('start-failed')
  })
})
