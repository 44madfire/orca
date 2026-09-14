import { randomUUID } from 'node:crypto'
import { runProcess } from '../../shared/child-process/run-process'
import { buildWslExecArgs, quotePosixShell } from '../../shared/wsl-login-shell-command'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'

export type WslGuestRunFn = (argv: readonly string[], timeoutMs: number) => Promise<number | null>

export type WslGuestHandleDeps = {
  runGuest?: WslGuestRunFn
}

export type WslGuestHandle = {
  readonly distro: string
  wrapGuestCommand(input: {
    cwd: string
    env: Readonly<Record<string, string>>
    command: string
    args: readonly string[]
  }): string[]
  observeStderr(chunk: Buffer | string): void
  guestPid: () => number | null
  retire: () => Promise<boolean>
}

const GUEST_KILL_TIMEOUT_MS = 5_000
const GUEST_VERIFY_TIMEOUT_MS = 5_000
const GUEST_VERIFY_ATTEMPTS = 3
const GUEST_VERIFY_RETRY_MS = 100

async function defaultRunGuest(
  distro: string,
  argv: readonly string[],
  timeoutMs: number
): Promise<number | null> {
  try {
    const result = await runProcess({
      program: 'wsl.exe',
      args: buildWslExecArgs(distro, [...argv]),
      cwd: resolveWslInteropSpawnCwd(),
      timeoutMs,
      maxOutputBytes: 4 * 1024
    })
    return result.timedOut ? null : result.code
  } catch {
    return null
  }
}

// Guest-side ownership for a WSL sidecar. The Windows wsl.exe wrapper can be
// adopted away by wslhost, so wrapper termination alone never proves the
// Linux service is gone. The wrapper script prints its pid pre-exec (same pid
// after exec) with a branch marker; teardown kills by explicit pid and
// verifies absence, failing closed when identity is unknown.
export function createWslGuestHandle(
  distro: string,
  deps: WslGuestHandleDeps = {}
): WslGuestHandle {
  const nonce = randomUUID().replace(/-/g, '')
  const marker = `__ORCA_SIDECAR_GUEST_${nonce}`
  const runGuest: WslGuestRunFn =
    deps.runGuest ?? ((argv, timeoutMs) => defaultRunGuest(distro, argv, timeoutMs))
  let pid: number | null = null
  let setsid = false
  let retiring: Promise<boolean> | null = null
  let buffer = ''

  const observeStderr = (chunk: Buffer | string): void => {
    if (pid !== null) {
      return
    }
    buffer += chunk.toString()
    const match = buffer.match(new RegExp(`${marker}_(SETSID|DIRECT)_(\\d+)`))
    const parsed = match ? Number(match[2]) : Number.NaN
    if (match && Number.isInteger(parsed) && parsed > 0) {
      pid = parsed
      setsid = match[1] === 'SETSID'
      buffer = ''
    } else if (buffer.length > 4096) {
      buffer = buffer.slice(-512)
    }
  }

  const isGone = async (target: number): Promise<boolean> => {
    // Gone only when neither the pid nor (for setsid trees) its group answers.
    // A read failure is unknown, never proof: fail closed.
    const probe = setsid
      ? ['sh', '-c', `kill -0 -- ${target} 2>/dev/null || kill -0 -- -${target} 2>/dev/null`]
      : ['sh', '-c', `kill -0 -- ${target} 2>/dev/null`]
    const code = await runGuest(probe, GUEST_VERIFY_TIMEOUT_MS).catch(() => null)
    return code !== null && code !== 0
  }

  const retire = (): Promise<boolean> => {
    if (retiring) {
      return retiring
    }
    const run = (async (): Promise<boolean> => {
      const target = pid
      // No observed pid means the guest never exec'd; nothing to own.
      if (target === null) {
        return true
      }
      const killArgv =
        setsid && target > 0
          ? ['sh', '-c', `kill -KILL -- -${target} 2>/dev/null`]
          : ['sh', '-c', `kill -KILL -- ${target} 2>/dev/null`]
      await runGuest(killArgv, GUEST_KILL_TIMEOUT_MS).catch(() => null)
      for (let attempt = 0; attempt < GUEST_VERIFY_ATTEMPTS; attempt += 1) {
        if (await isGone(target)) {
          return true
        }
        await new Promise((resolve) => setTimeout(resolve, GUEST_VERIFY_RETRY_MS))
      }
      return isGone(target)
    })()
    retiring = run
    void run.finally(() => {
      if (retiring === run) {
        retiring = null
      }
    })
    return retiring
  }

  return {
    distro,
    wrapGuestCommand(input) {
      const quoted = [input.command, ...input.args].map(quotePosixShell).join(' ')
      const assignments = Object.entries(input.env)
        .map(([key, value]) => quotePosixShell(`${key}=${value}`))
        .join(' ')
      const runLine = `exec ${assignments.length > 0 ? `/usr/bin/env ${assignments} ` : ''}${quoted}`
      const cdLine = `cd ${quotePosixShell(input.cwd)}`
      // Single quotes hold the marker still while double quotes let this
      // shell expand $$ to the pid the service keeps after exec.
      const printMarker = (mode: string): string => `printf '%s\n' '${marker}_${mode}_'"$$" >&2`
      const inner = `${printMarker('SETSID')}; ${cdLine} && ${runLine}`
      const script = [
        `if setsid --wait true 2>/dev/null; then`,
        `  exec setsid --wait sh -c ${quotePosixShell(inner)}`,
        `fi`,
        printMarker('DIRECT'),
        `${cdLine} && ${runLine}`
      ].join('\n')
      return ['sh', '-c', script]
    },
    observeStderr,
    guestPid: () => pid,
    retire
  }
}
