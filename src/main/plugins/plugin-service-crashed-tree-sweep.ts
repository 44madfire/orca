import { runProcess } from '../../shared/child-process/run-process'
import { windowsSystem32Binary } from '../../shared/child-process/windows-system-binary'
import { readWindowsProcessIdentityTableFresh } from '../windows/windows-process-table'

export type CrashedTreeRoot = {
  pid: number
  // Creation time captured while the sidecar was alive; null when the table
  // could not be read at startup. Gates below fail closed without it.
  creationTimeMs: number | null
}

export type CrashedTreeTableRow = {
  pid: number
  ppid: number
  creationTimeMs?: number
}

export type CrashedTreeSweepDeps = {
  platform?: NodeJS.Platform
  readTable?: () => Promise<readonly CrashedTreeTableRow[]>
  killPids?: (pids: readonly number[]) => Promise<unknown>
  killTimeoutMs?: number
  maxPasses?: number
}

const MAX_TREE_PIDS = 1024
const SWEEP_KILL_TIMEOUT_MS = 5_000
const SWEEP_MAX_PASSES = 3

// Creation time of a live root, for binding the crash sweep to the exact
// process the sidecar started. Null off-Windows and when unreadable.
export async function readServiceRootCreationTime(
  pid: number | undefined,
  deps: {
    platform?: NodeJS.Platform
    readTable?: () => Promise<readonly { pid: number; creationTimeMs?: number }[]>
  } = {}
): Promise<number | null> {
  if ((deps.platform ?? process.platform) !== 'win32') {
    return null
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return null
  }
  const rows = await (deps.readTable ?? readWindowsProcessIdentityTableFresh)().catch(() => null)
  const row = rows?.find((candidate) => candidate.pid === pid)
  return typeof row?.creationTimeMs === 'number' ? row.creationTimeMs : null
}

type OwnedFrontier = {
  pids: Set<number>
  seen: Map<number, number | undefined>
}

// Live rows owned by the crashed tree: ppid inside the frontier, with a
// reuse guard so children of a recycled intermediate pid are never selected.
// Accepted members extend the frontier, so one scan collects transitively
// while the quiescence loop still catches rows that appear between passes.
function memberRows(
  snap: readonly CrashedTreeTableRow[],
  frontier: OwnedFrontier,
  rootPid: number
): CrashedTreeTableRow[] {
  const members: CrashedTreeTableRow[] = []
  const byPid = new Map<number, CrashedTreeTableRow>()
  for (const row of snap) {
    if (!byPid.has(row.pid)) {
      byPid.set(row.pid, row)
    }
  }
  for (const row of snap) {
    if (members.length >= MAX_TREE_PIDS) {
      break
    }
    if (!Number.isInteger(row.pid) || row.pid <= 0 || !frontier.pids.has(row.ppid)) {
      continue
    }
    if (row.ppid !== rootPid && frontier.seen.has(row.ppid)) {
      const parent = byPid.get(row.ppid)
      const known = frontier.seen.get(row.ppid)
      if (parent && known !== undefined && parent.creationTimeMs !== known) {
        continue
      }
    }
    members.push(row)
    frontier.pids.add(row.pid)
    frontier.seen.set(row.pid, row.creationTimeMs)
  }
  return members
}

async function killWindowsPids(pids: readonly number[], timeoutMs: number): Promise<void> {
  const args: string[] = ['/F']
  for (const pid of pids) {
    args.push('/pid', String(pid))
  }
  // Explicit pid list only: no /T subtree walk from a possibly-reused root.
  await runProcess({
    program: windowsSystem32Binary('taskkill.exe'),
    args,
    timeoutMs,
    maxOutputBytes: 64 * 1024
  })
}

// Terminate what outlived a dead Windows service root and prove it is gone.
// Identity-gated (creation time bound while alive) with a quiescence loop over
// the owned frontier, so late spawns and disconnected leftovers are found.
// True when no owned rows remain; false (never throws) keeps the victim
// tracked so teardown retries instead of forgetting it.
export async function sweepCrashedServiceTree(
  root: CrashedTreeRoot,
  deps: CrashedTreeSweepDeps = {}
): Promise<boolean> {
  const platform = deps.platform ?? process.platform
  if (!Number.isInteger(root.pid) || root.pid <= 0) {
    return true
  }
  if (platform !== 'win32') {
    return true
  }
  const readTable = deps.readTable ?? readWindowsProcessIdentityTableFresh
  const killPids =
    deps.killPids ?? ((pids) => killWindowsPids(pids, deps.killTimeoutMs ?? SWEEP_KILL_TIMEOUT_MS))
  const maxPasses = deps.maxPasses ?? SWEEP_MAX_PASSES
  let snap = await readTable().catch(() => null)
  if (!snap) {
    return false
  }
  // A live row for the root means it never exited (defer); any other row for
  // the pid, or any row at all without a known identity, is unknowable.
  const rootRows = snap.filter((row) => row.pid === root.pid)
  if (root.creationTimeMs != null) {
    if (rootRows.some((row) => row.creationTimeMs === root.creationTimeMs)) {
      return false
    }
    if (rootRows.length > 0) {
      return false
    }
  } else if (rootRows.length > 0) {
    return false
  }
  const frontier: OwnedFrontier = { pids: new Set([root.pid]), seen: new Map() }
  // Pass 0 confirms every target against a second read before the first kill,
  // so a pid reused between snapshot and kill is never signalled.
  let members = memberRows(snap, frontier, root.pid)
  if (members.length > 0) {
    const confirm = await readTable().catch(() => null)
    if (!confirm) {
      return false
    }
    members = members.filter((member) => {
      const now = confirm.find((row) => row.pid === member.pid)
      // Absent now means it exited on its own; changed means it was reused.
      // Either way there is nothing of ours to kill under this pid.
      if (!now || now.ppid !== member.ppid || now.creationTimeMs !== member.creationTimeMs) {
        return false
      }
      return true
    })
    for (const member of members) {
      frontier.pids.add(member.pid)
      frontier.seen.set(member.pid, member.creationTimeMs)
    }
    if (members.length > 0) {
      const killed = await killPids(members.map((member) => member.pid)).then(
        () => true,
        () => false
      )
      if (!killed) {
        return false
      }
      // Fresh post-kill read: the confirm snapshot predates the kill.
      snap = await readTable().catch(() => null)
      if (!snap) {
        return false
      }
    } else {
      snap = confirm
    }
  }
  for (let pass = 1; pass < maxPasses; pass += 1) {
    const late = memberRows(snap, frontier, root.pid)
    if (late.length === 0) {
      return true
    }
    for (const member of late) {
      frontier.pids.add(member.pid)
      frontier.seen.set(member.pid, member.creationTimeMs)
    }
    const killed = await killPids(late.map((member) => member.pid)).then(
      () => true,
      () => false
    )
    if (!killed) {
      return false
    }
    snap = await readTable().catch(() => null)
    if (!snap) {
      return false
    }
  }
  return memberRows(snap, frontier, root.pid).length === 0
}
