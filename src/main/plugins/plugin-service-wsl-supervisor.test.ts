import { spawn, spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  buildGuestSweepScript,
  buildSupervisorArgv,
  buildSupervisorScript,
  buildWslSupervisorSpawn,
  isSupervisorControlLine,
  parseGuestSweepOutput,
  parseSupervisorLine,
  verifyGuestProcessNonce
} from './plugin-service-wsl-supervisor'

function shAvailable(): boolean {
  try {
    const result = spawnSync('sh', ['-c', 'true'], { stdio: 'ignore' })
    return !result.error && result.status === 0
  } catch {
    return false
  }
}

describe('supervisor script', () => {
  it('is --exec-safe: no login shell, dollar-safe under --exec', () => {
    const spawn = buildWslSupervisorSpawn('Ubuntu-24.04', 'nonce-1', '/home/you/repo', [
      '/usr/bin/svc',
      '--serve'
    ])
    expect(spawn.program).toBe('wsl.exe')
    expect(spawn.args).toContain('--exec')
    expect(spawn.args.join(' ')).not.toContain('-ilc')
    const argv = buildSupervisorArgv('nonce-1', '/home/you/repo', ['/usr/bin/svc'])
    // The lease enters at exec time through env(1): the only thing
    // /proc/<pid>/environ can prove about the supervisor itself.
    expect(argv[0]).toBe('/usr/bin/env')
    expect(argv[1]).toBe('ORCA_SIDECAR_NONCE=nonce-1')
    expect(argv).toContain('/bin/sh')
    expect(argv).toContain('/home/you/repo')
  })

  it('rejects non-word-safe nonces instead of smuggling argv', () => {
    expect(() => buildSupervisorArgv('a b', null, ['/usr/bin/svc'])).toThrow()
    expect(() => buildSupervisorArgv('a$b', null, ['/usr/bin/svc'])).toThrow()
  })

  it('parses nonce-bound control lines and rejects foreign ones', () => {
    expect(parseSupervisorLine('ORCA_SIDECAR_READY pid=12 nonce=n1', 'n1')).toEqual({
      type: 'ready',
      pid: 12
    })
    expect(parseSupervisorLine('ORCA_SIDECAR_CHILD pid=13 nonce=n1', 'n1')).toEqual({
      type: 'child',
      pid: 13
    })
    expect(parseSupervisorLine('ORCA_SIDECAR_EXIT status=3 nonce=n1', 'n1')).toEqual({
      type: 'exit',
      status: 3
    })
    // A stale generation's lines never parse as the current one.
    expect(parseSupervisorLine('ORCA_SIDECAR_READY pid=12 nonce=old', 'n1')).toBeNull()
    expect(parseSupervisorLine('ORCA_SIDECAR_READY pid=12 nonce=n1 trailing', 'n1')).toBeNull()
    expect(parseSupervisorLine('{"id":"1","result":1}', 'n1')).toBeNull()
    expect(isSupervisorControlLine('ORCA_SIDECAR_ANYTHING')).toBe(true)
    expect(isSupervisorControlLine('{"id":"1"}')).toBe(false)
  })
})

describe('verifyGuestProcessNonce', () => {
  // Fake guest filesystem: `present` pids have a /proc entry, `readable`
  // pids allow reading it, `owned` maps pid to its lease nonce.
  const guestRunner = ({
    present = new Set([42]),
    readable = new Set([42]),
    owned = new Map([[42, 'n1']]),
    procfs = true,
    throws = false
  }: {
    present?: Set<number>
    readable?: Set<number>
    owned?: Map<number, string>
    procfs?: boolean
    throws?: boolean
  } = {}) => {
    return async (args: readonly string[]): Promise<{ code: number | null; stdout: string }> => {
      if (throws) {
        throw new Error('transport down')
      }
      if (args[0] === 'test') {
        const dir = args[2] ?? ''
        if (dir === '/proc') {
          return { code: procfs ? 0 : 1, stdout: '' }
        }
        const pid = Number(/^\/proc\/(\d+)$/.exec(dir)?.[1])
        return { code: present.has(pid) ? 0 : 1, stdout: '' }
      }
      const pid = Number(/^\/proc\/(\d+)\/environ$/.exec(args[1] ?? '')?.[1])
      if (!readable.has(pid)) {
        return { code: 1, stdout: '' }
      }
      const nonce = owned.get(pid)
      return { code: 0, stdout: `PATH=/usr/bin\0ORCA_SIDECAR_NONCE=${nonce ?? 'other'}\0` }
    }
  }

  it('proves identity from /proc environ', async () => {
    const runner = guestRunner()
    expect(await verifyGuestProcessNonce(runner, 42, 'n1')).toBe('ours')
    expect(await verifyGuestProcessNonce(runner, 42, 'other')).toBe('not-ours')
  })

  it('reads a missing /proc entry as not-ours', async () => {
    const runner = guestRunner({ present: new Set(), readable: new Set(), owned: new Map() })
    expect(await verifyGuestProcessNonce(runner, 42, 'n1')).toBe('not-ours')
  })

  it('reads a live but unreadable identity as unknown, never not-ours', async () => {
    // EACCES-shaped: the /proc entry exists but environ cannot be read.
    const runner = guestRunner({ readable: new Set(), owned: new Map() })
    expect(await verifyGuestProcessNonce(runner, 42, 'n1')).toBe('unknown')
  })

  it('reads a missing /proc filesystem as unknown', async () => {
    const runner = guestRunner({
      present: new Set(),
      readable: new Set(),
      owned: new Map(),
      procfs: false
    })
    expect(await verifyGuestProcessNonce(runner, 42, 'n1')).toBe('unknown')
  })

  it('reads transport failures as unknown', async () => {
    expect(await verifyGuestProcessNonce(guestRunner({ throws: true }), 42, 'n1')).toBe('unknown')
    expect(await verifyGuestProcessNonce(guestRunner(), -1, 'n1')).toBe('unknown')
  })
})

describe('guest sweep', () => {
  it('kills supervisor and child, then reports survivors', () => {
    const script = buildGuestSweepScript(100, 101)
    expect(script).toContain('100')
    expect(script).toContain('101')
    expect(script).toContain('kill -9')
    expect(parseGuestSweepOutput('noise\nORCA_SWEEP done=1\n')).toEqual({ done: true, alive: [] })
    expect(parseGuestSweepOutput('ORCA_SWEEP done=0 alive= 100 101\n')).toEqual({
      done: false,
      alive: [100, 101]
    })
    expect(parseGuestSweepOutput('garbage\n')).toEqual({ done: false, alive: [] })
    // Only the proven-ours pid is signaled; a recycled co-target is excluded.
    const solo = buildGuestSweepScript(null, 101)
    expect(solo).toContain('targets="101"')
  })
})

function isPidDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'EPERM'
  }
}

const describeWithSh = shAvailable() ? describe : describe.skip

describeWithSh('supervisor protocol under sh', () => {
  it('reports ready/child/exit around a JSONL service', () => {
    const service = `line='{"id":"r1","result":"ok"}'; printf '%s\\n' "$line"; read ignored || true`
    const result = spawnSync(
      'sh',
      ['-c', buildSupervisorScript(), 'sup', '', 'sh', '-c', service],
      {
        input: '\n',
        encoding: 'utf8',
        env: { ...process.env, ORCA_SIDECAR_NONCE: 'test-nonce' }
      }
    )
    expect(result.status).toBe(0)
    const lines = String(result.stdout)
      .split('\n')
      .filter((line) => line.length > 0)
    const ready = parseSupervisorLine(lines[0], 'test-nonce')
    expect(ready?.type).toBe('ready')
    expect(lines).toContain('{"id":"r1","result":"ok"}')
    const exit = parseSupervisorLine(lines.at(-1) ?? '', 'test-nonce')
    expect(exit).toEqual({ type: 'exit', status: 0 })
  })

  it('transports a JSONL request through the supervisor to the service', () => {
    // The service backgrounds with an explicit stdin redirection; without
    // it the request would vanish into /dev/null and this would hang.
    const service = 'IFS= read -r req; printf \'{"id":"fixed1","result":"seen"}\\n\''
    const result = spawnSync(
      'sh',
      ['-c', buildSupervisorScript(), 'sup', '', 'sh', '-c', service],
      {
        input: '{"id":"fixed1","params":{}}' + '\n',
        encoding: 'utf8',
        env: { ...process.env, ORCA_SIDECAR_NONCE: 'pipe-nonce' }
      }
    )
    expect(result.status).toBe(0)
    expect(String(result.stdout)).toContain('ORCA_SIDECAR_READY pid=')
    expect(String(result.stdout)).toContain('{"id":"fixed1","result":"seen"}')
  })

  it('exports the nonce into the supervisor environment', () => {
    const service =
      'tr "\\0" "\\n" < /proc/$PPID/environ | grep ORCA_SIDECAR_NONCE || echo missing-sup'
    const result = spawnSync(
      'sh',
      ['-c', buildSupervisorScript(), 'sup', '', 'sh', '-c', service],
      {
        encoding: 'utf8',
        env: { ...process.env, ORCA_SIDECAR_NONCE: 'sup-nonce' }
      }
    )
    expect(String(result.stdout)).toContain('ORCA_SIDECAR_NONCE=sup-nonce')
  })

  it('exports the nonce into the service environment', () => {
    const service = 'tr "\\0" "\\n" < /proc/$$/environ | grep ORCA_SIDECAR_NONCE || echo missing'
    const result = spawnSync(
      'sh',
      ['-c', buildSupervisorScript(), 'sup', '', 'sh', '-c', service],
      {
        encoding: 'utf8',
        env: { ...process.env, ORCA_SIDECAR_NONCE: 'env-nonce' }
      }
    )
    expect(String(result.stdout)).toContain('ORCA_SIDECAR_NONCE=env-nonce')
  })

  it('propagates a failing service status', () => {
    const result = spawnSync(
      'sh',
      ['-c', buildSupervisorScript(), 'sup', '', 'sh', '-c', 'exit 3'],
      {
        encoding: 'utf8',
        env: { ...process.env, ORCA_SIDECAR_NONCE: 'fail-nonce' }
      }
    )
    expect(result.status).toBe(3)
    expect(String(result.stdout)).toContain('ORCA_SIDECAR_EXIT status=3 nonce=fail-nonce')
  })

  // POSIX-only: Windows TerminateProcess cannot deliver a trappable TERM,
  // so the trap path is proven here and on POSIX CI, not on win32 runners.
  const describeWithPosixSignals = shAvailable() && process.platform !== 'win32' ? it : it.skip
  describeWithPosixSignals('a TERM to the supervisor kills the service: no orphan', async () => {
    const supervised = spawn(
      'sh',
      [
        '-c',
        buildSupervisorScript(),
        'sup',
        '',
        'sh',
        '-c',
        // exec keeps the service at the supervised pid (no unsupervised middle).
        'exec sleep 30'
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ORCA_SIDECAR_NONCE: 'term-nonce' }
      }
    )
    let output = ''
    supervised.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    supervised.stderr.on('data', () => undefined)
    try {
      let servicePid = 0
      await vi.waitFor(() => {
        const match = /ORCA_SIDECAR_CHILD pid=(\d+) nonce=term-nonce/.exec(output)
        if (!match) {
          throw new Error('supervisor has not reported its child yet')
        }
        servicePid = Number(match[1])
      })
      supervised.kill('SIGTERM')
      const status: number | null = await new Promise((resolve) => {
        supervised.on('close', (code) => resolve(code))
      })
      expect(status).toBe(143)
      expect(isPidDead(servicePid)).toBe(true)
    } finally {
      supervised.kill('SIGKILL')
    }
  })

  // The lease must be provable from OUTSIDE the supervisor (this is what
  // the host's pre-kill check reads), not merely visible to its children.
  // POSIX-only: native Windows processes cannot see the MSYS /proc view.
  const describeWithProcfs = shAvailable() && process.platform !== 'win32' ? it : it.skip
  describeWithProcfs(
    'an external process reads the lease from the supervisor environ',
    async () => {
      const { readFileSync } = await import('node:fs')
      const supervised = spawn(
        'sh',
        ['-c', buildSupervisorScript(), 'sup', '', 'sh', '-c', 'exec sleep 30'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ORCA_SIDECAR_NONCE: 'ext-nonce' }
        }
      )
      let output = ''
      supervised.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      supervised.stderr.on('data', () => undefined)
      try {
        let supervisorPid = 0
        await vi.waitFor(() => {
          const match = /ORCA_SIDECAR_READY pid=(\d+) nonce=ext-nonce/.exec(output)
          if (!match) {
            throw new Error('supervisor has not reported readiness yet')
          }
          supervisorPid = Number(match[1])
        })
        const environ = readFileSync(`/proc/${supervisorPid}/environ`, 'utf8')
        expect(environ.split('\0')).toContain('ORCA_SIDECAR_NONCE=ext-nonce')
      } finally {
        supervised.kill('SIGKILL')
      }
    }
  )

  it('a missing lease exits before READY', () => {
    const result = spawnSync(
      'sh',
      ['-c', buildSupervisorScript(), 'sup', '', 'sh', '-c', 'exit 0'],
      {
        encoding: 'utf8',
        env: { ...process.env, ORCA_SIDECAR_NONCE: '' }
      }
    )
    expect(result.status).toBe(127)
    expect(String(result.stdout)).not.toContain('ORCA_SIDECAR_READY')
  })

  it('a bad guest cwd exits before READY', () => {
    const result = spawnSync(
      'sh',
      ['-c', buildSupervisorScript(), 'sup', '/no/such/dir', 'sh', '-c', 'exit 0'],
      { encoding: 'utf8', env: { ...process.env, ORCA_SIDECAR_NONCE: 'cwd-nonce' } }
    )
    expect(result.status).toBe(127)
    expect(String(result.stdout)).not.toContain('ORCA_SIDECAR_READY')
  })
})
