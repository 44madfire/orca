import { createRequire } from 'node:module'

// Job-object ownership for plain sidecar children, following the
// windows-pty-job.ts precedent: a handle answers "is this tree mine, and how
// do I kill it" so teardown never infers it from a parent-pid walk (which
// cannot survive pid reuse and cannot see reparented descendants).
//
// Unlike a PTY job, a sidecar job carries KILL_ON_JOB_CLOSE: a sidecar has no
// "user backgrounded" concept, so its whole tree belongs to the service and a
// host death must reap it rather than strand it.
//
// The three native exports below do not exist in the conpty module yet; the
// loader feature-detects them exactly like windows-pty-job.ts detects
// terminateJob, so a build predating the export degrades to `available: false`
// instead of throwing on every teardown. All policy — generation binding,
// stale-handle refusal, never-false verification — lives in this file and is
// covered with a fake native; only the syscall waits on the addon.
export type SidecarJobNative = {
  assignProcessToKillOnCloseJob: (pid: number) => number
  terminateSidecarJob: (handle: number, pid: number) => boolean
  closeSidecarJob: (handle: number) => void
}

export type SidecarJobHandle = {
  nativeHandle: number
  pid: number
  generation: number
}

const requireFromMain = createRequire(__filename)

let cachedNative: SidecarJobNative | null | undefined
let nativeLoader: () => SidecarJobNative | null = loadSidecarJobNative

function loadSidecarJobNative(): SidecarJobNative | null {
  if (cachedNative !== undefined) {
    return cachedNative
  }
  if (process.platform !== 'win32') {
    cachedNative = null
    return cachedNative
  }
  try {
    const { loadNativeModule } = requireFromMain('node-pty/lib/utils') as {
      loadNativeModule: (name: string) => { module: unknown }
    }
    const native = loadNativeModule('conpty').module as Partial<SidecarJobNative>
    cachedNative =
      typeof native?.assignProcessToKillOnCloseJob === 'function' &&
      typeof native?.terminateSidecarJob === 'function' &&
      typeof native?.closeSidecarJob === 'function'
        ? (native as SidecarJobNative)
        : null
  } catch {
    cachedNative = null
  }
  return cachedNative
}

export type SidecarJobBinder = {
  readonly available: boolean
  bind: (pid: number, generation: number) => SidecarJobHandle | null
  terminate: (handle: SidecarJobHandle, generation: number) => boolean
  release: (handle: SidecarJobHandle) => void
}

// Bind a kill-on-close job around a freshly spawned pid. The bind must happen
// before the child can spawn anything of its own; callers spawn suspended or
// bind synchronously right after spawn and treat failure as unavailable.
export function createSidecarJobBinder(
  reportKill?: (pid: number) => void,
  loader: () => SidecarJobNative | null = nativeLoader
): SidecarJobBinder {
  const native = loader()
  if (!native) {
    return {
      available: false,
      bind: () => null,
      terminate: () => false,
      release: () => undefined
    }
  }
  return {
    available: true,
    bind: (pid: number, generation: number) => {
      if (!Number.isInteger(pid) || pid <= 0) {
        return null
      }
      let nativeHandle: number
      try {
        nativeHandle = native.assignProcessToKillOnCloseJob(pid)
      } catch {
        return null
      }
      if (!Number.isInteger(nativeHandle)) {
        return null
      }
      return { nativeHandle, pid, generation }
    },
    terminate: (handle: SidecarJobHandle, generation: number) => {
      // A stale generation's handle never addresses the current tree.
      if (handle.generation !== generation) {
        return false
      }
      let terminated: boolean
      try {
        terminated = native.terminateSidecarJob(handle.nativeHandle, handle.pid)
      } catch {
        return false
      }
      if (terminated) {
        reportKill?.(handle.pid)
      }
      return terminated
    },
    release: (handle: SidecarJobHandle) => {
      try {
        native.closeSidecarJob(handle.nativeHandle)
      } catch {
        /* handle already gone */
      }
    }
  }
}

/** Whether this build can own sidecar trees with job objects at all. */
export function isSidecarJobOwnershipAvailable(): boolean {
  return nativeLoader() !== null
}

/** Test-only: substitute the native module (it is resolved via createRequire). */
export function __setSidecarJobNativeForTests(loader?: () => SidecarJobNative | null): void {
  nativeLoader = loader ?? loadSidecarJobNative
  cachedNative = undefined
}
