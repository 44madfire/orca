import { runProcess } from '../shared/child-process/run-process'

// Why: Squirrel.Mac's ShipIt waits for EVERY running instance of the target
// bundle to exit before it installs, and aborts with "App Still Running Error"
// if one appears mid-install. A second packaged Orca — a manually opened copy,
// or an agent/e2e rig launching /Applications/Orca.app with a temp profile,
// often windowless and invisible — silently stalls the update forever while the
// user sees "the app quit but never relaunched, still on the old version".
// Naming those instances before the install handoff turns a silent wedge into
// an actionable message.
const RUNNING_APPLICATION_QUERY_TIMEOUT_MS = 2_000
const RUNNING_APPLICATION_QUERY_MAX_BYTES = 64 * 1024

// Why AppKit and not `ps`: the Orca CLI runs from this same executable under
// ELECTRON_RUN_AS_NODE, so an exact-executable process scan reports every CLI
// invocation as a blocker and refuses updates on any machine that uses the CLI.
// AppKit gives those processes no bundle identity, and Squirrel does not wait
// for them either — so requiring a non-null bundleIdentifier matches Squirrel's
// own blocking set. See the regression in the sibling test file.
const RUNNING_APPLICATION_QUERY = String.raw`
function run(argv) {
  ObjC.import('AppKit')
  const executablePath = argv[0]
  const currentPid = Number(argv[1])
  const applications = $.NSWorkspace.sharedWorkspace.runningApplications
  const pids = []
  for (let index = 0; index < applications.count; index += 1) {
    const application = applications.objectAtIndex(index)
    const executableUrl = application.executableURL
    const bundleIdentifier = application.bundleIdentifier
    const pid = Number(application.processIdentifier)
    if (
      executableUrl &&
      bundleIdentifier &&
      String(ObjC.unwrap(executableUrl.path)) === executablePath &&
      pid !== currentPid
    ) {
      pids.push(String(pid))
    }
  }
  return pids.join('\n')
}`

export type RunningApplicationPidReader = (
  executablePath: string,
  currentPid: number
) => Promise<string>

async function readRunningApplicationPids(
  executablePath: string,
  currentPid: number
): Promise<string> {
  // Why: one bounded subprocess instead of a probe per candidate. Paths go
  // through argv so nothing is interpolated into the script, and NSWorkspace
  // metadata needs no Accessibility permission.
  const result = await runProcess({
    program: '/usr/bin/osascript',
    args: [
      '-l',
      'JavaScript',
      '-e',
      RUNNING_APPLICATION_QUERY,
      '--',
      executablePath,
      String(currentPid)
    ],
    timeoutMs: RUNNING_APPLICATION_QUERY_TIMEOUT_MS,
    maxOutputBytes: RUNNING_APPLICATION_QUERY_MAX_BYTES
  })
  return runningApplicationQueryOutput(result)
}

/**
 * Output only from a query that actually finished.
 *
 * Why it is a decision at all: `runProcess` reports a non-zero exit or a timeout
 * as data rather than throwing, so partial stdout arrives looking like an answer.
 * A probe that could not finish has proved nothing about who is running, and
 * naming a blocker on that basis would refuse an install the user could have had.
 *
 * `outputTruncated` is the third way to get a partial list and the only one that
 * arrives with a clean exit: the bounded sink clips at `maxOutputBytes` and says
 * so precisely because callers that parse the output have to tell a short answer
 * from a clipped one. Unreachable in practice — the cap holds thousands of pids —
 * but this is the fail-open path, where the contract is the safety property.
 */
export function runningApplicationQueryOutput(result: {
  timedOut: boolean
  code: number | null
  stdout: string
  outputTruncated?: boolean
}): string {
  if (result.timedOut || result.code !== 0 || result.outputTruncated === true) {
    return ''
  }
  return result.stdout
}

export function parseRunningApplicationPids(output: string, currentPid: number): number[] {
  const pids: number[] = []
  for (const line of output.split('\n')) {
    const normalized = line.trim()
    if (!/^\d+$/.test(normalized)) {
      continue
    }
    const pid = Number(normalized)
    if (pid > 0 && pid !== currentPid) {
      pids.push(pid)
    }
  }
  return pids
}

export type ConflictingInstanceDeps = {
  platform?: NodeJS.Platform
  executablePath?: string
  currentPid?: number
  readRunningApplicationPids?: RunningApplicationPidReader
}

/**
 * Pids of other running app instances launched from this same executable.
 *
 * macOS-only by design: this mirrors Squirrel.Mac's pre-install wait/abort
 * semantics, and the Windows and Linux installers manage running instances
 * themselves. Fails open — an unavailable query must never block an install.
 */
export async function findConflictingAppInstancePids(
  deps: ConflictingInstanceDeps = {}
): Promise<number[]> {
  if ((deps.platform ?? process.platform) !== 'darwin') {
    return []
  }
  const executablePath = deps.executablePath ?? process.execPath
  const currentPid = deps.currentPid ?? process.pid
  try {
    const output = await (deps.readRunningApplicationPids ?? readRunningApplicationPids)(
      executablePath,
      currentPid
    )
    return parseRunningApplicationPids(output, currentPid)
  } catch {
    return []
  }
}

const MAX_REPORTED_CONFLICTING_PIDS = 5

/** Actionable copy for the update card: what is blocking, and what to do. */
export function describeConflictingAppInstances(pids: readonly number[]): string {
  const reported = pids.slice(0, MAX_REPORTED_CONFLICTING_PIDS)
  const suffix = pids.length > reported.length ? ', …' : ''
  const [subject, closing] =
    pids.length === 1
      ? [`Another copy of Orca is running (PID ${reported[0]})`, 'it is open — quit it']
      : [
          `${pids.length} other copies of Orca are running (PIDs ${reported.join(', ')}${suffix})`,
          'they are open — quit them'
        ]
  return `${subject}. macOS cannot replace the app while ${closing}, then try again.`
}
