import { spawn, spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  buildGuestSweepArgv,
  buildGuestSweepScript,
  buildSupervisorArgv,
  buildSupervisorScript,
  buildWslSupervisorSpawn,
  isSupervisorControlLine,
  parseGuestSweepOutput,
  parseSupervisorLine
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

  it('maps an explicit environment exactly and validates names', () => {
    const argv = buildSupervisorArgv('nonce-1', null, ['/usr/bin/svc'], {
      FOO_REQ: 'req-value',
      EMPTY_OK: ''
    })
    const envIndex = argv.indexOf('/usr/bin/env')
    expect(argv[envIndex + 1]).toBe('-i')
    expect(argv).toContain('FOO_REQ=req-value')
    expect(argv).toContain('EMPTY_OK=')
    expect(argv).toContain('ORCA_SIDECAR_NONCE=nonce-1')
    expect(() => buildSupervisorArgv('nonce-1', null, ['/usr/bin/svc'], { '0BAD': 'x' })).toThrow()
    expect(() =>
      buildSupervisorArgv('nonce-1', null, ['/usr/bin/svc'], {
        BAD: `has${String.fromCharCode(0)}nul`
      })
    ).toThrow()
  })

  it('leaves the distro default in place without an explicit map', () => {
    const argv = buildSupervisorArgv('nonce-1', null, ['/usr/bin/svc'])
    expect(argv).not.toContain('-i')
    expect(argv).toContain('ORCA_SIDECAR_NONCE=nonce-1')
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

describe('sweep lease gating', () => {
  it('pins the in-guest verification semantics', () => {
    const script = buildGuestSweepScript()
    expect(script).toContain('bearers()')
    expect(script).toContain('kill_bearers -TERM')
    expect(script).toContain('kill_bearers -KILL')
    // Unreadable identities are skipped by construction (2>/dev/null),
    // which can only make the quiescence report loud, never wrong.
    expect(script).toContain('2>/dev/null; then echo')
  })
})

describe('guest sweep', () => {
  it('verifies the lease adjacent to each signal, then reports survivors', () => {
    const script = buildGuestSweepScript()
    expect(script).toContain('kill_bearers -TERM')
    expect(script).toContain('kill_bearers -KILL')
    expect(script).toContain('ORCA_SIDECAR_NONCE=$nonce')
    // Shell-parseable on every platform: sh -n would have caught the
    // missing-bracket regression before any guest ever ran it.
    for (const text of [script, buildSupervisorScript()]) {
      const parsed = spawnSync('sh', ['-n', '-c', text])
      expect(parsed.error).toBeUndefined()
      expect(parsed.status).toBe(0)
    }
    const argv = buildGuestSweepArgv('sweep-nonce')
    expect(argv.slice(0, 4)).toEqual(['/bin/sh', '-c', script, 'orca-sweep'])
    expect(argv.slice(4)).toEqual(['sweep-nonce'])
    expect(parseGuestSweepOutput('noise\nORCA_SWEEP done=1\n')).toEqual({ done: true, alive: [] })
    expect(parseGuestSweepOutput('ORCA_SWEEP done=0 alive= 100 101\n')).toEqual({
      done: false,
      alive: [100, 101]
    })
    expect(parseGuestSweepOutput('garbage\n')).toEqual({ done: false, alive: [] })
  })

  it('rejects non-word-safe nonces instead of smuggling script', () => {
    expect(() => buildGuestSweepArgv('a b')).toThrow()
    expect(() => buildGuestSweepArgv('a$b')).toThrow()
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

  it('applies an exact environment and exposes no ambient variables', () => {
    const service = [
      'echo "FOO_REQ=$FOO_REQ"; echo "NONCE=$ORCA_SIDECAR_NONCE";',
      'if [ -z "${JUNK_AMBIENT:-}" ]; then echo NO_JUNK; else echo HAS_JUNK; fi; exit 0'
    ].join(' ')
    const argv = buildSupervisorArgv('env-exact', '', ['sh', '-c', service], {
      FOO_REQ: 'req-value'
    })
    // argv[0] is the POSIX path production passes to wsl.exe; on a Windows
    // runner the same binary is reached through PATH instead.
    const program = process.platform === 'win32' ? 'env' : argv[0]
    const result = spawnSync(program, argv.slice(1), {
      encoding: 'utf8',
      env: { ...process.env, JUNK_AMBIENT: 'junk' }
    })
    const output = String(result.stdout)
    expect(result.status).toBe(0)
    expect(output).toContain('ORCA_SIDECAR_READY pid=')
    expect(output).toContain('FOO_REQ=req-value')
    expect(output).toContain('NONCE=env-exact')
    expect(output).toContain('NO_JUNK')
    expect(output).not.toContain('HAS_JUNK')
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

  // A recycled pid observed as a target but foreign at signal time must
  // never be signaled: the stranger below stands in for the replacement.
  // Everything runs inside one shell so the sweep shares a process tree
  // with its targets on every platform (cross-tree /proc views vary).
  it('the sweep kills a lease-holder and spares an identity-changed pid', () => {
    const sweepBody = buildGuestSweepScript()
    expect(typeof sweepBody).toBe('string')
    const driver = [
      'ORCA_SIDECAR_NONCE=sweep-n1 sleep 30 & owned=$!;',
      'sleep 30 & stranger=$!;',
      'sh -c "$SWEEP_BODY" sweep-helper sweep-n1 "$owned" "$stranger";',
      'wait "$owned" 2>/dev/null;',
      'if kill -0 "$owned" 2>/dev/null; then echo OWNED_ALIVE; else echo OWNED_DEAD; fi;',
      'if kill -0 "$stranger" 2>/dev/null; then echo STRANGER_ALIVE; else echo STRANGER_DEAD; fi;',
      'kill -9 "$stranger" 2>/dev/null'
    ].join(' ')
    const result = spawnSync('sh', ['-c', driver], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, SWEEP_BODY: sweepBody as string }
    })
    const output = String(result.stdout)
    expect(result.status).toBe(0)
    // The sweep killed the lease-holder and spared the stranger on every
    // platform. Its done=1 verdict additionally needs zombie visibility
    // (/proc/PID/stat state), which MSYS cannot provide for this tree, so
    // the conservative done=0 stands in for it on Windows runners.
    if (process.platform !== 'win32') {
      expect(output).toContain('ORCA_SWEEP done=1')
    }
    expect(output).toContain('OWNED_DEAD')
    expect(output).toContain('STRANGER_ALIVE')
  })

  // The sidecar spawns a long-lived grandchild that the host never learns
  // the pid of; teardown must still prove the entire guest tree is gone.
  // Same-tree throughout so MSYS runners observe it as well as Linux.
  it('reaps the whole guest tree including grandchildren', () => {
    const supervisorBody = buildSupervisorScript()
    expect(typeof supervisorBody).toBe('string')
    const sweepBody = buildGuestSweepScript()
    expect(typeof sweepBody).toBe('string')
    const driver = [
      'ORCA_SIDECAR_NONCE=tree-nonce sh -c "$SUPERVISOR_BODY" sup-helper \'\' sh -c \'sleep 30 & wait\' >"$OUT" 2>&1 & sup=$!;',
      'i=0; child="";',
      'while [ "$i" -lt 100 ]; do',
      'child=$(sed -n \'s/^ORCA_SIDECAR_CHILD pid=\\([0-9]*\\) nonce=tree-nonce$/\\1/p\' "$OUT" | head -1);',
      '[ -n "$child" ] && break;',
      'sleep 0.1; i=$((i + 1));',
      'done;',
      '[ -n "$child" ] || { echo NOCHILD; kill -9 $sup 2>/dev/null; exit 1; };',
      'sh -c "$SWEEP_BODY" sweep-helper tree-nonce "$sup" "$child";',
      'wait "$sup" 2>/dev/null;',
      'kill -0 "$sup" 2>/dev/null && echo SUP_ALIVE || echo SUP_DEAD;',
      'kill -0 -- "-$child" 2>/dev/null && echo GROUP_ALIVE || echo GROUP_EMPTY'
    ].join(' ')
    const driverWithOut = `OUT=$(mktemp); ${driver}; rm -f "$OUT"`
    const result = spawnSync('sh', ['-c', driverWithOut], {
      encoding: 'utf8',
      timeout: 25000,
      input: '',
      env: {
        ...process.env,
        SUPERVISOR_BODY: supervisorBody as string,
        SWEEP_BODY: sweepBody as string
      }
    })
    const output = String(result.stdout)
    expect(result.status).toBe(0)
    expect(output).toContain('ORCA_SWEEP done=1')
    expect(output).toContain('SUP_DEAD')
    expect(output).toContain('GROUP_EMPTY')
  })

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
