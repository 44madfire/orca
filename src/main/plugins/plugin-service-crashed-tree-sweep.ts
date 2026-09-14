import { runProcess } from '../../shared/child-process/run-process'
import { windowsSystem32Binary } from '../../shared/child-process/windows-system-binary'
import { readWindowsProcessIdentityTableFresh } from '../windows/windows-process-table'

export type CrashedTreeTableRow = {
  pid: number
  ppid: number
}

export type CrashedTreeSweepDeps = {
  platform?: NodeJS.Platform
  readTable?: () => Promise<readonly CrashedTreeTableRow[]>
  killPids?: (pids: readonly number[]) => Promise<unknown>
  killTimeoutMs?: number
}

const MAX_TREE_PIDS = 1024
const SWEEP_KILL_TIMEOUT_MS = 5_000

// Live descendants of a dead root, by ppid walk. Windows orphans keep their
// creator pid (no pid-1 reparenting), so rows pointing at the vacated root
// are real descendants; visited-guarded against pid-reuse cycles.
export function collectCrashedTree(
  rootPid: number,
  rows: readonly CrashedTreeTableRow[]
): number[] {
  const byPpid = new Map<number, number[]>()
  for (const row of rows) {
    if (!Number.isInteger(row.pid) || row.pid <= 0) {
      continue
    }
    const siblings = byPpid.get(row.ppid)
    if (siblings) {
      siblings.push(row.pid)
    } else {
      byPpid.set(row.ppid, [row.pid])
    }
  }
  const found: number[] = []
  const visited = new Set<number>([rootPid])
  const queue = [rootPid]
  for (let index = 0; index < queue.length && found.length < MAX_TREE_PIDS; index += 1) {
    for (const pid of byPpid.get(queue[index]) ?? []) {
      if (visited.has(pid)) {
        continue
      }
      visited.add(pid)
      found.push(pid)
      queue.push(pid)
    }
  }
  return found
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
// True when no descendants remain on a fresh re-read; false (never throws)
// keeps the victim tracked so teardown retries instead of forgetting it.
export async function sweepCrashedServiceTree(
  rootPid: number,
  deps: CrashedTreeSweepDeps = {}
): Promise<boolean> {
  const platform = deps.platform ?? process.platform
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return true
  }
  if (platform !== 'win32') {
    return true
  }
  const readTable = deps.readTable ?? readWindowsProcessIdentityTableFresh
  const before = await readTable().catch(() => null)
  if (!before) {
    return false
  }
  const targets = collectCrashedTree(rootPid, before)
  if (targets.length === 0) {
    return true
  }
  const killPids =
    deps.killPids ?? ((pids) => killWindowsPids(pids, deps.killTimeoutMs ?? SWEEP_KILL_TIMEOUT_MS))
  const killed = await killPids(targets).then(
    () => true,
    () => false
  )
  if (!killed) {
    return false
  }
  const after = await readTable().catch(() => null)
  return after ? collectCrashedTree(rootPid, after).length === 0 : false
}
