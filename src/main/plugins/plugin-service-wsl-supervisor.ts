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
    'nonce="${ORCA_SIDECAR_NONCE:-}"; guestCwd="$1"; shift',
    // The lease must arrive at exec time (the host runs the shell through
    // `env VAR=...`): /proc/<pid>/environ reflects the exec environment, so
    // an export here could never authenticate the supervisor itself. A
    // missing lease exits before READY so the host reports start-failed.
    'if [ -z "$nonce" ]; then exit 127; fi',
    // The guest cwd comes from the resolved runtime, never the panel. A
    // failed cd exits before READY so the host reports start-failed.
    'if [ -n "$guestCwd" ]; then cd "$guestCwd" || exit 127; fi',
    // Duplicating the host pipe to fd 3 before spawning: a background job
    // with no explicit stdin redirection reads /dev/null under
    // non-interactive sh, which would starve the service of requests.
    'exec 3<&0 || exit 127',
    `printf '%s\\n' "${CONTROL_PREFIX}READY pid=$$ nonce=$nonce"`,
    'child=',
    // The trap kills the direct child and waits: no exit path strands what
    // it knows. Unknown descendants are owned by the sweep lease scan.
    'trap \'kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 143\' TERM INT HUP',
    // Explicit redirection onto the fd-3 dup: without it the backgrounded
    // service would read /dev/null instead of the host pipe.
    '"$@" <&3 &',
    'child=$!',
    `printf '%s\\n' "${CONTROL_PREFIX}CHILD pid=$child nonce=$nonce"`,
    'wait "$child"',
    'status=$?',
    'trap - TERM INT HUP',
    `printf '%s\\n' "${CONTROL_PREFIX}EXIT status=$status nonce=$nonce"`,
    'exit "$status"'
  ].join('\n')
}

// The supervisor shell is exec'd through env(1) so the lease lands in its
// exec-time environment: the only thing /proc/<pid>/environ can prove.
// The nonce travels as one argv word (never through shell expansion or
// WSLENV), so it must be shell-word-safe; the host mints UUIDs.
const NONCE_WORD_RE = /^[A-Za-z0-9_-]+$/

// Explicit guest environment for the service. `env` argv words carry
// arbitrary values safely (no shell parsing between wsl.exe and env(1)),
// so names are restricted but values only forbid NUL. With an explicit map
// the service sees exactly it plus the lease (`env -i`: nothing ambient);
// without one the service inherits the distro default plus the lease.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function buildSupervisorArgv(
  nonce: string,
  guestCwd: string | null,
  serviceArgv: readonly string[],
  env?: Record<string, string | undefined> | undefined
): string[] {
  if (!NONCE_WORD_RE.test(nonce)) {
    throw new Error('sidecar nonce must be a shell-word-safe token')
  }
  const assignments: string[] = []
  for (const [name, value] of Object.entries(env ?? {})) {
    // Undefined entries cannot exist in an exec environment; skip them the
    // way a spawn layer drops them rather than smuggling the word.
    if (value === undefined) {
      continue
    }
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`invalid environment name: ${name}`)
    }
    if (value.includes('\0')) {
      throw new Error(`environment value for ${name} contains NUL`)
    }
    assignments.push(`${name}=${value}`)
  }
  return [
    '/usr/bin/env',
    ...(env === undefined ? [] : ['-i']),
    ...assignments,
    `${SIDECAR_NONCE_ENV}=${nonce}`,
    '/bin/sh',
    '-c',
    buildSupervisorScript(),
    'orca-sidecar-supervisor',
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

export function buildGuestSweepScript(): string {
  const LF = String.fromCharCode(10)
  return [
    'nonce="$1"',
    // Refuse an empty or smuggled lease: an empty pattern would match any
    // lease-holder, so a missing argv fails closed instead of signaling.
    'case "$nonce" in ""|*[!A-Za-z0-9_-]*) exit 1 ;; esac',
    'procroot="${ORCA_SWEEP_PROCROOT:-/proc}"',
    'bearers() {',
    '  for d in "$procroot"/[0-9]*; do',
    '    [ -d "$d" ] || continue',
    '    p=${d##*/}',
    '    case "$p" in ""|*[!0-9]*) continue ;; esac',
    '    if grep -qF "ORCA_SIDECAR_NONCE=$nonce" "$d/environ" 2>/dev/null; then echo "$p"; fi',
    '  done',
    '}',
    'kill_bearers() {',
    '  sig="$1"',
    '  for p in $(bearers); do kill "$sig" "$p" 2>/dev/null; done',
    '}',
    'kill_bearers -TERM',
    'i=0; while [ "$i" -lt 20 ]; do',
    '  if [ -z "$(bearers)" ]; then echo "ORCA_SWEEP done=1"; exit 0; fi',
    '  sleep 0.25; i=$((i + 1))',
    'done',
    'kill_bearers -KILL',
    'i=0; while [ "$i" -lt 20 ]; do',
    '  if [ -z "$(bearers)" ]; then echo "ORCA_SWEEP done=1"; exit 0; fi',
    '  sleep 0.25; i=$((i + 1))',
    'done',
    'alive=""; for p in $(bearers); do alive="$alive $p"; done',
    'echo "ORCA_SWEEP done=0 alive=$alive"',
    'exit 0'
  ].join(LF)
}
// Argv for one sweep invocation: only the lease travels (safe under
// wsl.exe --exec). Targets are discovered in-distro by the script itself,
// so a stale host pid can never redirect a kill.
export function buildGuestSweepArgv(nonce: string): string[] {
  if (!NONCE_WORD_RE.test(nonce)) {
    throw new Error('sidecar nonce must be a shell-word-safe token')
  }
  return ['/bin/sh', '-c', buildGuestSweepScript(), 'orca-sweep', nonce]
}

export function parseGuestSweepOutput(stdout: string): { done: boolean; alive: number[] } {
  const match = /^ORCA_SWEEP done=([01])( alive=(.*))?$/.exec(stdout.trim().split('\n').pop() ?? '')
  if (!match) {
    return { done: false, alive: [] }
  }
  const alive =
    match[2]
      ?.split(' ')
      .map((part) => Number(part))
      .filter((pid) => Number.isInteger(pid) && pid > 0) ?? []
  return { done: match[1] === '1', alive }
}
