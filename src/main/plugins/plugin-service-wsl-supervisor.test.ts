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
    expect(argv[0]).toBe('/bin/sh')
    // Nonce and cwd travel as argv, never through wsl.exe expansion or WSLENV.
    expect(argv).toContain('nonce-1')
    expect(argv).toContain('/home/you/repo')
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
  it('proves identity from /proc environ', async () => {
    const runner = async () => ({
      code: 0,
      stdout: `PATH=/usr/bin\0ORCA_SIDECAR_NONCE=n1\0HOME=/home/you\0`
    })
    expect(await verifyGuestProcessNonce(runner, 42, 'n1')).toBe('ours')
    expect(await verifyGuestProcessNonce(runner, 42, 'other')).toBe('not-ours')
  })

  it('reads a missing /proc entry as not-ours and failures as unknown', async () => {
    expect(await verifyGuestProcessNonce(async () => ({ code: 1, stdout: '' }), 42, 'n1')).toBe(
      'not-ours'
    )
    expect(
      await verifyGuestProcessNonce(
        async () => {
          throw new Error('transport down')
        },
        42,
        'n1'
      )
    ).toBe('unknown')
    expect(await verifyGuestProcessNonce(async () => ({ code: 0, stdout: '' }), -1, 'n1')).toBe(
      'unknown'
    )
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
      ['-c', buildSupervisorScript(), 'sup', 'test-nonce', '', 'sh', '-c', service],
      {
        input: '\n',
        encoding: 'utf8'
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

  it('exports the nonce into the service environment', () => {
    const service = 'tr "\\0" "\\n" < /proc/$$/environ | grep ORCA_SIDECAR_NONCE || echo missing'
    const result = spawnSync(
      'sh',
      ['-c', buildSupervisorScript(), 'sup', 'env-nonce', '', 'sh', '-c', service],
      {
        encoding: 'utf8'
      }
    )
    expect(String(result.stdout)).toContain('ORCA_SIDECAR_NONCE=env-nonce')
  })

  it('propagates a failing service status', () => {
    const result = spawnSync(
      'sh',
      ['-c', buildSupervisorScript(), 'sup', 'fail-nonce', '', 'sh', '-c', 'exit 3'],
      {
        encoding: 'utf8'
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
        'term-nonce',
        '',
        'sh',
        '-c',
        // exec keeps the service at the supervised pid (no unsupervised middle).
        'exec sleep 30'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
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

  it('a bad guest cwd exits before READY', () => {
    const result = spawnSync(
      'sh',
      ['-c', buildSupervisorScript(), 'sup', 'cwd-nonce', '/no/such/dir', 'sh', '-c', 'exit 0'],
      { encoding: 'utf8' }
    )
    expect(result.status).toBe(127)
    expect(String(result.stdout)).not.toContain('ORCA_SIDECAR_READY')
  })
})
