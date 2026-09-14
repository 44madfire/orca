import { runProcess } from '../../shared/child-process/run-process'
import { windowsSystem32Binary } from '../../shared/child-process/windows-system-binary'
import { readWindowsProcessIdentityTableFresh } from '../windows/windows-process-table'

export type CrashedTreeRoot = {
  pid: number
  // Creation time captured while the sidecar was alive; null when the table
  // could not be read at startup. Identity gates fail closed without it.
  creationTimeMs: number | null
  // Upper bound for legitimate births attributed to dead parents. Omitted
  // (null) by unit tests that do not model post-retire spawns.
  notAfterMs?: number | null
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
// A wedged table reader must surface as unverified, never hang teardown.
const SWEEP_READ_TIMEOUT_MS = 10_000

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

type TreeScan = {
  qualified: CrashedTreeTableRow[]
  // Rows that exist but cannot be proven ours. Any of these fails the sweep
  // closed: killing one could signal an unrelated process.
  unqualified: number
}

// Live rows owned by the crashed tree. Every accepted row must carry a known
// creation time strictly after its parent's: an orphan that predates the root
// and a reused pid with foreign timing both break the causal chain. Windows
// orphans keep their creator pid, so a dead unreused parent proves nothing
// against its children; a live parent row with a changed creation time proves
// reuse, and rows beneath it are foreign. Grows a transient scratch copy so
// one scan collects transitively; only confirmed rows join the real frontier.
function scanTree(
  snap: readonly CrashedTreeTableRow[],
  owned: OwnedFrontier,
  root: CrashedTreeRoot,
  tainted: ReadonlySet<number>
): TreeScan {
  const pids = new Set(owned.pids)
  const seen = new Map(owned.seen)
  const qualified: CrashedTreeTableRow[] = []
  let unqualified = 0
  const byPid = new Map<number, CrashedTreeTableRow>()
  for (const row of snap) {
    if (!byPid.has(row.pid)) {
      byPid.set(row.pid, row)
    }
  }
  for (const row of snap) {
    if (qualified.length + unqualified >= MAX_TREE_PIDS) {
      break
    }
    if (!Number.isInteger(row.pid) || row.pid <= 0 || !pids.has(row.ppid)) {
      continue
    }
    // A pid observed with conflicting identities across reads can never be
    // trusted again; rows beneath it are not signalled on any path.
    if (tainted.has(row.ppid)) {
      unqualified += 1
      continue
    }
    const parentCt = row.ppid === root.pid ? root.creationTimeMs : seen.get(row.ppid)
    if (
      typeof row.creationTimeMs !== 'number' ||
      typeof parentCt !== 'number' ||
      !(row.creationTimeMs > parentCt)
    ) {
      unqualified += 1
      continue
    }
    if (row.ppid !== root.pid) {
      const parent = byPid.get(row.ppid)
      // A live intermediate parent with foreign timing proves this pid was
      // reused after our descendant died; rows beneath it are not ours.
      if (parent && parent.creationTimeMs !== seen.get(row.ppid)) {
        unqualified += 1
        continue
      }
    }
    // Births attributed to an already-dead parent must predate retirement: a
    // dead pid cannot spawn, so anything newer is foreign or unprovable.
    // Rows with live parents are always current and skip this bound.
    const parentAlive = row.ppid === root.pid ? false : byPid.has(row.ppid)
    if (!parentAlive && root.notAfterMs != null && !(row.creationTimeMs < root.notAfterMs)) {
      unqualified += 1
      continue
    }
    qualified.push(row)
    pids.add(row.pid)
    seen.set(row.pid, row.creationTimeMs)
  }
  return { qualified, unqualified }
}

// Any live row for the dead root pid ends the sweep: a matching creation
// time means the owner never exited (defer), anything else means the pid was
// reused or cannot be identified (unknowable either way).
function rootReusedOrAlive(snap: readonly CrashedTreeTableRow[], root: CrashedTreeRoot): boolean {
  return snap.some((row) => row.pid === root.pid)
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
// Identity-gated (creation time bound while alive, causal order per edge,
// every kill batch reconfirmed on a fresh snapshot) with a quiescence loop
// over the owned frontier, so late spawns and disconnected leftovers are
// found. True when no owned rows remain; false (never throws) keeps the
// victim tracked so teardown retries instead of forgetting it.
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
  const readTableWithTimeout = (): Promise<readonly CrashedTreeTableRow[] | null> => {
    let read: Promise<readonly CrashedTreeTableRow[]>
    try {
      read = (deps.readTable ?? readWindowsProcessIdentityTableFresh)()
    } catch {
      return Promise.resolve(null)
    }
    const giveUp = new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), SWEEP_READ_TIMEOUT_MS)
      timer.unref?.()
    })
    return Promise.race([
      read.then((rows) => rows as readonly CrashedTreeTableRow[] | null),
      giveUp
    ]).catch(() => null)
  }
  const killPids =
    deps.killPids ?? ((pids) => killWindowsPids(pids, deps.killTimeoutMs ?? SWEEP_KILL_TIMEOUT_MS))
  const maxPasses = deps.maxPasses ?? SWEEP_MAX_PASSES
  const owned: OwnedFrontier = { pids: new Set([root.pid]), seen: new Map() }
  const tainted = new Set<number>()
  let snap = await readTableWithTimeout()
  if (!snap || rootReusedOrAlive(snap, root)) {
    return false
  }
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const found = scanTree(snap, owned, root, tainted)
    if (found.unqualified > 0) {
      return false
    }
    if (found.qualified.length === 0) {
      return true
    }
    const confirm = await readTableWithTimeout()
    if (!confirm || rootReusedOrAlive(confirm, root)) {
      return false
    }
    const confirmed = new Set<number>()
    const killable: CrashedTreeTableRow[] = []
    for (const member of found.qualified) {
      const now = confirm.find((row) => row.pid === member.pid)
      if (!now) {
        // Exited on its own between the reads: join its identity so already-
        // orphaned children stay discoverable, but kill nothing for it.
        owned.pids.add(member.pid)
        owned.seen.set(member.pid, member.creationTimeMs)
        continue
      }
      // Changed means this pid was reused by a foreign process: taint it so
      // rows beneath it are never signalled, and join nothing.
      if (now.ppid !== member.ppid || now.creationTimeMs !== member.creationTimeMs) {
        tainted.add(member.pid)
        continue
      }
      owned.pids.add(member.pid)
      owned.seen.set(member.pid, member.creationTimeMs)
      confirmed.add(member.pid)
    }
    for (const member of found.qualified) {
      // A member is only killable through a confirmed parent: an unconfirmed
      // candidate's pid in another row's ppid proves nothing either way.
      if (
        confirmed.has(member.pid) &&
        (member.ppid === root.pid ||
          confirmed.has(member.ppid) ||
          (owned.seen.has(member.ppid) && !confirm.some((row) => row.pid === member.ppid)))
      ) {
        killable.push(member)
      }
    }
    if (killable.length === 0) {
      snap = confirm
      continue
    }
    const killed = await killPids(killable.map((member) => member.pid)).then(
      () => true,
      () => false
    )
    if (!killed) {
      return false
    }
    snap = await readTableWithTimeout()
    if (!snap || rootReusedOrAlive(snap, root)) {
      return false
    }
  }
  const final = scanTree(snap, owned, root, tainted)
  return final.unqualified === 0 && final.qualified.length === 0
}
