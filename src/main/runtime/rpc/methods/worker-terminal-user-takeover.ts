import type { OrcaRuntimeService } from '../../orca-runtime'
import { sweepSettledWorkerResumeFences } from './settled-worker-resume-fence-sweep'

/**
 * The one host-side record of "a human took this worker's terminal over".
 *
 * Every input lane ends here, because the fence it writes is what stops `workerRelease` from
 * closing a settled worker's PTY under whoever is typing in it. The desktop and web renderers
 * report the takeover over RPC from their real-user-input signal; mobile has no such signal and
 * arrives as bytes, so its lane records through the byte entry point below. Both land on the
 * runtime that owns the terminal — local, SSH-hosted, or a remote host — which is also the runtime
 * holding the orchestration database, so the takeover survives restarts and renderer remounts.
 */
export function recordWorkerTerminalUserTakeover(
  runtime: OrcaRuntimeService,
  paneKey: string | null | undefined
): number {
  if (!paneKey) {
    return 0
  }
  const changed = runtime.getOrchestrationDb().markWorkerTerminalUserOwned(paneKey)
  if (changed > 0) {
    // Only a real takeover retires the resource; ordinary panes report here too and must not
    // pay for a plan read on every keystroke window.
    sweepSettledWorkerResumeFences(runtime)
  }
  return changed
}

/**
 * The same record, for a lane that carries the user's bytes instead of a report.
 *
 * Callers must have already established that the bytes are deliberate human input — an agent's
 * `terminal send` reaches the same method and must never fence a release. Never throws: a terminal
 * the orchestration database cannot answer for is still a terminal the user is typing into.
 *
 * Keystrokes arrive one at a time, so the database is asked whether this pane has anything left to
 * fence before the write lock is taken. Remembering that answer instead would be unsound: the pane
 * can enter a new ownership population at any moment — a worker whose authority attaches while the
 * user is already typing — and a remembered "nothing to fence" would then outlive its precondition
 * and let the release close the terminal under them.
 */
export function recordWorkerTerminalUserTakeoverFromInput(
  runtime: OrcaRuntimeService,
  handle: string
): void {
  try {
    const paneKey = runtime.getTerminalPaneKey(handle)
    if (!paneKey || !runtime.getOrchestrationDb().hasWorkerTerminalUserTakeoverCandidate(paneKey)) {
      return
    }
    recordWorkerTerminalUserTakeover(runtime, paneKey)
  } catch (error) {
    console.warn('[orchestration] worker terminal takeover record failed', error)
  }
}
