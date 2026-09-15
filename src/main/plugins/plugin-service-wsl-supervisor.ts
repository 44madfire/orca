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
    // Job control puts the backgrounded service in its own process group
    // (pgid equals its pid), so teardown reaps the whole guest subtree —
    // helpers and grandchildren included — instead of only the direct
    // child. Best-effort: without it the service shares this shell's
    // group and teardown stays correct, just coarser.
    'set -m 2>/dev/null || true',
    `printf '%s\\n' "${CONTROL_PREFIX}READY pid=$$ nonce=$nonce"`,
    'child=',
    // The trap kills the service directly, then its process group (helpers
    // and grandchildren that never daemonized away), then waits: no exit
    // path strands the guest subtree. A double-forked daemon escapes any
    // same-tree reaping by design and stays out of scope.
    'trap \'kill "$child" 2>/dev/null; kill -TERM -- "-$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 143\' TERM INT HUP',
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

export type GuestCommandRunner = (args: readonly string[]) => Promise<{
  code: number | null
  stdout: string
}>

// In-distro identity proof: the lease sits in the exec-time environment,
// so /proc/<pid>/environ either names our generation (ours), names another
// one (not-ours: recycled pid), or cannot decide. Existence and readability
// are probed separately: cat(1) reports one exit code for a missing file
// and for EACCES, and only a missing /proc entry proves absence. A live
// process with an unreadable identity is `unknown` — never permission to
// kill, never evidence of exit.
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
    const entry = await runner(['test', '-d', `/proc/${pid}`])
    if (entry.code !== 0) {
      // No /proc entry: gone — unless /proc itself is missing, in which
      // case this host cannot answer at all.
      const proc = await runner(['test', '-d', '/proc'])
      return proc.code === 0 ? 'not-ours' : 'unknown'
    }
    const result = await runner(['cat', `/proc/${pid}/environ`])
    if (result.code !== 0) {
      // Present but unreadable (EACCES, ptrace scope, corrupted): alive
      // as far as anyone can prove, identity withheld.
      return 'unknown'
    }
    stdout = result.stdout
  } catch {
    return 'unknown'
  }
  const token = `${SIDECAR_NONCE_ENV}=${nonce}`
  return stdout.split('\0').includes(token) ? 'ours' : 'not-ours'
}

// One guest invocation that verifies ownership adjacent to each signal,
// then kills, escalates to -KILL, and reports who is still alive. The host
// runs it bounded (runProcess timeout) and treats any surviving pid as
// teardown-unverified.
//
// The in-distro environ match is the kill gate, never an earlier host
// probe: a pid that died and recycled after the host's skip-check fails the
// match here and is never signaled, and an unreadable identity is skipped
// the same way. `ORCA_SWEEP_PROCROOT` overrides /proc for tests only.
export function buildGuestSweepScript(): string {
  const LF = String.fromCharCode(10)
  return [
    'nonce="$1"; shift',
    // Refuse an empty or smuggled lease: an empty pattern would match any
    // lease-holder, so a missing argv fails closed instead of signaling.
    'case "$nonce" in ""|*[!A-Za-z0-9_-]*) exit 1 ;; esac',
    'procroot="${ORCA_SWEEP_PROCROOT:-/proc}"',
    'verified() {',
    '  p="$1"',
    '  case "$p" in ""|*[!0-9]*) return 1 ;; esac',
    '  if grep -qF "ORCA_SIDECAR_NONCE=$nonce" "$procroot/$p/environ" 2>/dev/null; then',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    'is_live() {',
    '  p="$1"',
    '  kill -0 "$p" 2>/dev/null || return 1',
    '  stat=$(cat "$procroot/$p/stat" 2>/dev/null) || return 0',
    '  stat=${stat##*)}',
    '  case "$stat" in " Z"*) return 1 ;; esac',
    '  return 0',
    '}',
    'group_live() {',
    '  g="$1"',
    '  case "$g" in ""|*[!0-9]*) return 1 ;; esac',
    '  kill -0 -- "-$g" 2>/dev/null',
    '}',
    'kill_tree() {',
    '  sig="$1"; shift',
    '  for p in "$@"; do',
    '    if [ "$p" = "$sup" ]; then',
    '      if verified "$p"; then kill "$sig" "$p" 2>/dev/null; fi',
    '    else',
    '      if verified "$p"; then kill "$sig" "$p" 2>/dev/null; kill "$sig" -- "-$p" 2>/dev/null; fi',
    '    fi',
    '  done',
    '}',
    'collect_status() {',
    '  alive=""',
    '  cgroup=""',
    '  if [ -n "$sup" ] && is_live "$sup"; then alive="$alive $sup"; fi',
    '  if [ -n "$child" ] && group_live "$child"; then cgroup="$child"; fi',
    '}',
    'sup="$1"; child="$2"',
    'kill_tree -TERM "$sup" "$child"',
    'i=0; while [ "$i" -lt 20 ]; do',
    '  collect_status',
    '  if [ -z "$alive$cgroup" ]; then echo "ORCA_SWEEP done=1"; exit 0; fi',
    '  sleep 0.25; i=$((i + 1))',
    'done',
    'kill_tree -KILL "$sup" "$child"',
    'i=0; while [ "$i" -lt 20 ]; do',
    '  collect_status',
    '  if [ -z "$alive$cgroup" ]; then echo "ORCA_SWEEP done=1"; exit 0; fi',
    '  sleep 0.25; i=$((i + 1))',
    'done',
    'collect_status',
    'echo "ORCA_SWEEP done=0 alive=$alive group=$cgroup"',
    'exit 0'
  ].join(LF)
}
export type GuestSweepReport = { done: boolean; alive: number[]; groups: number[] }

function parsePidList(value: string | undefined): number[] {
  return (
    value
      ?.split(' ')
      .map((part) => Number(part))
      .filter((pid) => Number.isInteger(pid) && pid > 0) ?? []
  )
}

// Argv for one sweep invocation: the lease plus supervisor and child pids
// travel as words (safe under wsl.exe --exec), never baked into the script.
// All three are validated here and re-guarded in-script, where the environ
// match remains the kill gate adjacent to each signal.
export function buildGuestSweepArgv(
  nonce: string,
  supervisorPid: number | null,
  childPid: number | null
): string[] {
  if (!NONCE_WORD_RE.test(nonce)) {
    throw new Error('sidecar nonce must be a shell-word-safe token')
  }
  for (const pid of [supervisorPid, childPid]) {
    if (pid !== null && (!Number.isInteger(pid) || pid <= 0)) {
      throw new Error('sweep target must be a positive pid')
    }
  }
  return [
    '/bin/sh',
    '-c',
    buildGuestSweepScript(),
    'orca-sweep',
    nonce,
    supervisorPid === null ? '' : String(supervisorPid),
    childPid === null ? '' : String(childPid)
  ]
}

export function parseGuestSweepOutput(stdout: string): GuestSweepReport {
  const match = /^ORCA_SWEEP done=([01])( alive=(.*?))?( group=(.*?))?$/.exec(
    stdout.trim().split('\n').pop() ?? ''
  )
  if (!match) {
    return { done: false, alive: [], groups: [] }
  }
  return { done: match[1] === '1', alive: parsePidList(match[3]), groups: parsePidList(match[5]) }
}
