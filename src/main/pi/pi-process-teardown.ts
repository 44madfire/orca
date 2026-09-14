// Pi RPC child tree termination (SNC1.9 native Pi).
//
// Mirrors the Codex app-server teardown shape (`codex-app-server-process-
// teardown`) without importing it: the Pi child is spawned detached on POSIX
// so it leads its own process group, and group signalling reaches
// grandchildren even after they daemonise. Windows goes through the shared
// process-tree kill. Everything is injectable so tests prove the verdicts
// without forking real trees.

import { captureDescendantSnapshot, type DescendantSnapshot } from '../pty-descendant-termination'
import { terminateDescendantSnapshotAndWait } from '../pty-descendant-exit-verification'
import {
  terminateWindowsProcessTree,
  type WindowsTreeKiller
} from '../windows-process-tree-kill'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'

type TeardownChild = {
  pid?: number
  kill(signal: NodeJS.Signals): boolean
}

export type PiProcessTeardownDeps = {
  platform?: NodeJS.Platform
  terminateWindowsTree?: WindowsTreeKiller
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void
  isPidPresent?: (pid: number) => boolean
  captureDescendants?: (rootPid: number) => Promise<DescendantSnapshot | null>
  terminateDescendants?: (snapshot: DescendantSnapshot) => Promise<boolean>
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // An already-gone PID is the desired outcome.
  }
}

function defaultIsPidPresent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

/**
 * The provider root was observed dead but its descendant tree could not be
 * verified. The lease may release the reservation; nothing is claimed about
 * descendants. Never thrown when a descendant was observed still alive.
 */
export class PiRootExitObservedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'PiRootExitObservedError'
  }
}

/** True once the OS reports the PID gone (ESRCH); permission errors stay present. */
export function isPiPidAbsent(pid: number, deps: PiProcessTeardownDeps = {}): boolean {
  const present = deps.isPidPresent ?? defaultIsPidPresent
  try {
    return !present(pid)
  } catch {
    return false
  }
}

/**
 * Sweep one Pi child's tree after its RPC close. Returns true only when the
 * sweep ran; root-exit observation stays with the connection close result —
 * the driver proves the full exit from both facts, never from one alone.
 */
export async function terminatePiProcessTree(
  child: TeardownChild,
  opts: { detached: boolean },
  deps: PiProcessTeardownDeps = {}
): Promise<boolean> {
  const rootPid = child.pid
  if (!rootPid) {
    return false
  }
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    const terminate = deps.terminateWindowsTree ?? terminateWindowsProcessTree
    await terminate(rootPid, { site: 'pi-rpc-teardown' })
    sendSignal(rootPid, 'SIGKILL')
    return true
  }
  if (opts.detached) {
    const signalGroup =
      deps.signalProcessGroup ?? ((pgid: number, signal: NodeJS.Signals) => process.kill(-pgid, signal))
    try {
      signalGroup(rootPid, 'SIGKILL')
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === 'ESRCH'
    }
    recordSelfInitiatedTreeKill({ pid: rootPid, site: 'pi-rpc-teardown', scope: 'posix-process-group' })
    return true
  }
  const capture = deps.captureDescendants ?? captureDescendantSnapshot
  const snapshot = await capture(rootPid).catch(() => null)
  if (!snapshot) {
    sendSignal(rootPid, 'SIGKILL')
    return true
  }
  const terminate = deps.terminateDescendants ?? terminateDescendantSnapshotAndWait
  const exited = await terminate(snapshot)
  if (!exited) {
    return false
  }
  sendSignal(rootPid, 'SIGKILL')
  return true
}
