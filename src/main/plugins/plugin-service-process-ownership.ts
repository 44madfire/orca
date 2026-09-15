import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'
import { readWindowsProcessIdentityTable } from '../windows/windows-process-table'
import type { SidecarJobBinder, SidecarJobHandle } from './plugin-service-windows-job'

// Ownership-safe teardown for a sidecar child.
//
// A pid alone cannot answer "is this tree mine": pids recycle and descendants
// reparent. So every claim captures creation-time identity (pid +
// creationTimeMs, the same pair windows-process-table rows carry) and every
// teardown verifies absence BY IDENTITY. Outcomes use the SSH-boundary
// vocabulary: `exited` needs positive evidence, anything else is
// `unverifiable` — never a false `terminated`.
export type SidecarTeardownVerdict = 'terminated' | 'exited' | 'unverifiable' | 'stale'

export type ClaimedSidecarProcess = {
  pid: number
  generation: number
  creationTimeMs: number | null
  identityReady: Promise<void>
  job: SidecarJobHandle | null
}

export type ProcessOwnershipDeps = {
  readCreationTimeMs?: (pid: number) => Promise<number | null>
  terminateTree?: (child: SpawnedProcess) => Promise<boolean>
  isPidAlive?: (pid: number) => boolean
  jobBinder?: SidecarJobBinder | null
  identityTimeoutMs?: number
  verifyPollMs?: number
  verifyDeadlineMs?: number
}

const IDENTITY_TIMEOUT_MS = 2_000
const VERIFY_POLL_MS = 25
const VERIFY_DEADLINE_MS = 5_000

export function defaultReadCreationTimeMs(pid: number): Promise<number | null> {
  if (process.platform !== 'win32') {
    return Promise.resolve(null)
  }
  return readWindowsProcessIdentityTable().then(
    (rows) => rows.find((row) => row.pid === pid)?.creationTimeMs ?? null,
    () => null
  )
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM proves liveness (a process we may not signal); only ESRCH proves exit.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Claim a freshly spawned child. Binds the kill-on-close job synchronously
// (before the child can spawn anything) and enriches creation-time identity
// asynchronously; teardown awaits identityReady first (enrich-or-await), so a
// pid is never addressed before it is proven ours.
export function claimSidecarProcess(
  pid: number | undefined,
  generation: number,
  deps: ProcessOwnershipDeps = {}
): ClaimedSidecarProcess | null {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return null
  }
  const childPid = pid as number
  const readCreationTimeMs = deps.readCreationTimeMs ?? defaultReadCreationTimeMs
  const claim: ClaimedSidecarProcess = {
    pid: childPid,
    generation,
    creationTimeMs: null,
    identityReady: Promise.resolve(),
    job: deps.jobBinder?.available ? (deps.jobBinder.bind(childPid, generation) ?? null) : null
  }
  claim.identityReady = withTimeout(
    readCreationTimeMs(childPid).then(
      (creationTimeMs) => {
        claim.creationTimeMs = creationTimeMs
      },
      () => undefined
    ),
    deps.identityTimeoutMs ?? IDENTITY_TIMEOUT_MS
  )
  return claim
}

// Terminate a claimed child. A stale generation never touches the tree;
// without a proven-gone identity the answer is `unverifiable`, never success.
export async function terminateClaimedSidecar(
  claim: ClaimedSidecarProcess,
  child: SpawnedProcess | null,
  generation: number,
  deps: ProcessOwnershipDeps = {}
): Promise<SidecarTeardownVerdict> {
  if (claim.generation !== generation) {
    return 'stale'
  }
  await claim.identityReady
  if (claim.generation !== generation) {
    return 'stale'
  }
  const binder = deps.jobBinder
  if (binder?.available && claim.job) {
    if (binder.terminate(claim.job, generation)) {
      return (await verifyAbsenceByIdentity(claim, deps)) ? 'terminated' : 'unverifiable'
    }
  }
  if (child) {
    const terminateTree = deps.terminateTree ?? forceTerminateProcessTree
    let issued = false
    try {
      issued = await terminateTree(child)
    } catch {
      issued = false
    }
    if (claim.generation !== generation) {
      return 'stale'
    }
    const gone = await verifyAbsenceByIdentity(claim, deps)
    if (gone) {
      return issued ? 'terminated' : 'exited'
    }
    return 'unverifiable'
  }
  // No live handle: never address the pid blind. Gone-by-identity reads as
  // exited; anything else stays unverifiable.
  return (await verifyAbsenceByIdentity(claim, deps)) ? 'exited' : 'unverifiable'
}

// Absence BY IDENTITY: a missing pid proves exit; a different creation time
// proves our process died and the pid recycled (do not kill it); the same
// creation time with a live pid proves nothing is gone.
async function verifyAbsenceByIdentity(
  claim: ClaimedSidecarProcess,
  deps: ProcessOwnershipDeps
): Promise<boolean> {
  const readCreationTimeMs = deps.readCreationTimeMs ?? defaultReadCreationTimeMs
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive
  const pollMs = deps.verifyPollMs ?? VERIFY_POLL_MS
  const deadline = Date.now() + (deps.verifyDeadlineMs ?? VERIFY_DEADLINE_MS)
  for (;;) {
    let creationTimeMs: number | null = null
    try {
      creationTimeMs = await readCreationTimeMs(claim.pid)
    } catch {
      creationTimeMs = null
    }
    if (creationTimeMs === null) {
      if (!isPidAlive(claim.pid)) {
        return true
      }
    } else if (claim.creationTimeMs !== null && creationTimeMs !== claim.creationTimeMs) {
      return true
    } else if (!isPidAlive(claim.pid)) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
  }
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
    timer.unref?.()
  })
  return Promise.race([promise.catch(() => undefined), deadline]).then(() => {
    clearTimeout(timer)
  })
}
