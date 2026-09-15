import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'

// Guest-side supervisor: owns the actual guest process so the host never has
// to trust the wrapper (wsl.exe) pid. The supervisor is the service's direct
// parent — its `wait` is authoritative — reports in-distro pids bound to a
// per-generation nonce, and kills its child on every exit path. Killing
// wsl.exe alone does NOT stop the guest (the VM outlives the wrapper), so
// teardown always follows the wrapper kill with an in-distro sweep + verify.
//
// Transport note: run WITHOUT a login shell (`/bin/sh -c`, never `-ilc`) so
// no rc/motd banner pollutes the JSONL stream, and always under `--exec` so
// wsl.exe passes the script byte-for-byte (see wsl-command-execution.md).
export const SIDECAR_NONCE_ENV = 'ORCA_SIDECAR_NONCE'
const CONTROL_PREFIX = 'ORCA_SIDECAR_'

export type SupervisorControlEvent =
  | { type: 'ready'; pid: number }
  | { type: 'child'; pid: number }
  | { type: 'exit'; status: number }

// Single canonical supervisor. POSIX-sh only (no bashisms): it also runs
// under Git Bash sh in tests. stdin/stdout are the service's own streams;
// control lines carry the generation nonce so a stale generation's output
// can never be mistaken for the current one.
export function buildSupervisorScript(): string {
  return [
    'nonce="$1"; guestCwd="$2"; shift 2',
    // The guest cwd comes from the resolved runtime, never the panel. A
    // failed cd exits before READY so the host reports start-failed.
    'if [ -n "$guestCwd" ]; then cd "$guestCwd" || exit 127; fi',
    `printf '%s\\n' "${CONTROL_PREFIX}READY pid=$$ nonce=$nonce"`,
    'child=',
    'cleanup() {',
    '  if [ -n "$child" ]; then kill "$child" 2>/dev/null; fi',
    '}',
    "trap 'cleanup; exit 143' TERM INT HUP",
    // Value quoted, name bare: quoting any of the name turns the assignment
    // into a command word and the service never starts.
    `${SIDECAR_NONCE_ENV}="$nonce" "$@" &`,
    'child=$!',
    `printf '%s\\n' "${CONTROL_PREFIX}CHILD pid=$child nonce=$nonce"`,
    'wait "$child"',
    'status=$?',
    'trap - TERM INT HUP',
    `printf '%s\\n' "${CONTROL_PREFIX}EXIT status=$status nonce=$nonce"`,
    'exit "$status"'
  ].join('\n')
}

export function buildSupervisorArgv(
  nonce: string,
  guestCwd: string | null,
  serviceArgv: readonly string[]
): string[] {
  return [
    '/bin/sh',
    '-c',
    buildSupervisorScript(),
    'orca-sidecar-supervisor',
    nonce,
    guestCwd ?? '',
    ...serviceArgv
  ]
}

export function buildWslSupervisorSpawn(
  distro: string,
  nonce: string,
  guestCwd: string | null,
  serviceArgv: readonly string[]
): { program: string; args: string[] } {
  return {
    program: 'wsl.exe',
    args: buildWslExecArgs(distro, buildSupervisorArgv(nonce, guestCwd, serviceArgv))
  }
}

// Prefix pre-filter for the transport: cheap, nonce-agnostic. Full validation
// (nonce match) happens in parseSupervisorLine.
export function isSupervisorControlLine(line: string): boolean {
  return line.startsWith(CONTROL_PREFIX)
}

const READY_RE = /^ORCA_SIDECAR_READY pid=(\d+) nonce=(\S+)$/
const CHILD_RE = /^ORCA_SIDECAR_CHILD pid=(\d+) nonce=(\S+)$/
const EXIT_RE = /^ORCA_SIDECAR_EXIT status=(\d+) nonce=(\S+)$/

export function parseSupervisorLine(line: string, nonce: string): SupervisorControlEvent | null {
  let match = READY_RE.exec(line)
  if (match && match[2] === nonce) {
    return { type: 'ready', pid: Number(match[1]) }
  }
  match = CHILD_RE.exec(line)
  if (match && match[2] === nonce) {
    return { type: 'child', pid: Number(match[1]) }
  }
  match = EXIT_RE.exec(line)
  if (match && match[2] === nonce) {
    return { type: 'exit', status: Number(match[1]) }
  }
  return null
}

export type GuestCommandRunner = (args: readonly string[]) => Promise<{
  code: number | null
  stdout: string
}>

// In-distro identity proof: the supervisor exports the nonce into the
// service's environment, so /proc/<pid>/environ either names our generation
// (ours), names nothing (not-ours: recycled pid), or is unreadable (unknown).
// `unknown` is never evidence of exit — callers hold `unverifiable`.
export async function verifyGuestProcessNonce(
  runner: GuestCommandRunner,
  pid: number,
  nonce: string
): Promise<'ours' | 'not-ours' | 'unknown'> {
  if (!Number.isInteger(pid) || pid <= 0 || nonce.length === 0) {
    return 'unknown'
  }
  let stdout: string
  try {
    const result = await runner(['cat', `/proc/${pid}/environ`])
    if (result.code !== 0) {
      // No /proc entry: gone (or never ours). Confirm liveness separately.
      return 'not-ours'
    }
    stdout = result.stdout
  } catch {
    return 'unknown'
  }
  const token = `${SIDECAR_NONCE_ENV}=${nonce}`
  return stdout.split('\0').includes(token) ? 'ours' : 'not-ours'
}

// One guest invocation that kills the proven-ours targets, escalates to
// -9, and reports who is still alive. The host runs it bounded (runProcess
// timeout) and treats any surviving pid as teardown-unverified. Either pid
// may be null when only the other was proven ours.
export function buildGuestSweepScript(
  supervisorPid: number | null,
  childPid: number | null
): string {
  const targets = [supervisorPid, childPid].filter(
    (pid): pid is number => Number.isInteger(pid) && (pid as number) > 0
  )
  const unique = [...new Set(targets)].join(' ')
  return [
    `targets="${unique}"`,
    'for p in $targets; do kill "$p" 2>/dev/null; done',
    'i=0; while [ "$i" -lt 20 ]; do',
    '  alive=""; for p in $targets; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done',
    '  if [ -z "$alive" ]; then printf \'%s\\n\' "ORCA_SWEEP done=1"; exit 0; fi',
    '  sleep 0.25; i=$((i + 1))',
    'done',
    'for p in $targets; do kill -9 "$p" 2>/dev/null; done',
    'i=0; while [ "$i" -lt 20 ]; do',
    '  alive=""; for p in $targets; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done',
    '  if [ -z "$alive" ]; then printf \'%s\\n\' "ORCA_SWEEP done=1"; exit 0; fi',
    '  sleep 0.25; i=$((i + 1))',
    'done',
    'alive=""; for p in $targets; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done',
    'printf \'%s\\n\' "ORCA_SWEEP done=0 alive=$alive"',
    'exit 0'
  ].join('\n')
}

export function parseGuestSweepOutput(stdout: string): { done: boolean; alive: number[] } {
  const match = /^ORCA_SWEEP done=([01])( alive=(.*))?$/.exec(stdout.trim().split('\n').pop() ?? '')
  if (!match) {
    return { done: false, alive: [] }
  }
  const alive =
    match[3]
      ?.split(' ')
      .map((part) => Number(part))
      .filter((pid) => Number.isInteger(pid) && pid > 0) ?? []
  return { done: match[1] === '1', alive }
}
