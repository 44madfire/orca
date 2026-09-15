import { describe, expect, it, vi } from 'vitest'
import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { claimSidecarProcess, terminateClaimedSidecar } from './plugin-service-process-ownership'
import type { SidecarJobBinder, SidecarJobHandle } from './plugin-service-windows-job'

function fakeChild(): SpawnedProcess {
  return { pid: 4242, kill: () => true } as unknown as SpawnedProcess
}

function fakeBinder(): SidecarJobBinder & {
  bound: SidecarJobHandle[]
  terminated: SidecarJobHandle[]
  released: SidecarJobHandle[]
} {
  const bound: SidecarJobHandle[] = []
  const terminated: SidecarJobHandle[] = []
  const released: SidecarJobHandle[] = []
  let nextHandle = 1
  return {
    available: true,
    bound,
    terminated,
    released,
    bind: (pid, generation) => {
      const handle = { nativeHandle: nextHandle++, pid, generation }
      bound.push(handle)
      return handle
    },
    terminate: (handle, generation) => {
      if (handle.generation !== generation) {
        return false
      }
      terminated.push(handle)
      return true
    },
    release: (handle) => {
      released.push(handle)
    }
  }
}

describe('claimSidecarProcess', () => {
  it('binds the kill-on-close job synchronously at spawn', () => {
    const binder = fakeBinder()
    const claim = claimSidecarProcess(4242, 1, {
      jobBinder: binder,
      readCreationTimeMs: async () => 111
    })
    expect(claim?.job).not.toBeNull()
    expect(binder.bound).toHaveLength(1)
    expect(binder.bound[0]).toMatchObject({ pid: 4242, generation: 1 })
  })

  it('rejects pids that cannot name a process', () => {
    expect(claimSidecarProcess(undefined, 1)).toBeNull()
    expect(claimSidecarProcess(0, 1)).toBeNull()
    expect(claimSidecarProcess(-4, 1)).toBeNull()
  })
})

describe('terminateClaimedSidecar', () => {
  it('terminates through the job handle and verifies absence', async () => {
    const binder = fakeBinder()
    const claim = claimSidecarProcess(4242, 1, {
      jobBinder: binder,
      readCreationTimeMs: async () => 111,
      isPidAlive: () => false
    })!
    const verdict = await terminateClaimedSidecar(claim, fakeChild(), 1, {
      jobBinder: binder,
      readCreationTimeMs: async () => null,
      isPidAlive: () => false
    })
    expect(verdict).toBe('terminated')
    expect(binder.terminated).toHaveLength(1)
  })

  it('a stale generation never touches the tree', async () => {
    const binder = fakeBinder()
    const terminateTree = vi.fn(async () => true)
    const claim = claimSidecarProcess(4242, 1, {
      jobBinder: binder,
      readCreationTimeMs: async () => 111
    })!
    const verdict = await terminateClaimedSidecar(claim, fakeChild(), 2, {
      jobBinder: binder,
      terminateTree,
      readCreationTimeMs: async () => 111,
      isPidAlive: () => true
    })
    expect(verdict).toBe('stale')
    expect(binder.terminated).toEqual([])
    expect(terminateTree).not.toHaveBeenCalled()
  })

  it('reports exited when the process is already gone', async () => {
    const claim = claimSidecarProcess(4242, 1, {
      readCreationTimeMs: async () => 111,
      isPidAlive: () => false
    })!
    const terminateTree = vi.fn(async () => false)
    const verdict = await terminateClaimedSidecar(claim, fakeChild(), 1, {
      terminateTree,
      readCreationTimeMs: async () => null,
      isPidAlive: () => false
    })
    expect(verdict).toBe('exited')
  })

  it('reads a recycled pid as exited without killing the new process', async () => {
    // Our process died; the pid now names a different creation time. The
    // verdict must be exited, and no tree kill may be issued against it.
    const claim = claimSidecarProcess(4242, 1, {
      readCreationTimeMs: async () => 111,
      isPidAlive: () => true
    })!
    await claim.identityReady
    const terminateTree = vi.fn(async () => true)
    const verdict = await terminateClaimedSidecar(claim, null, 1, {
      terminateTree,
      readCreationTimeMs: async () => 999,
      isPidAlive: () => true
    })
    expect(verdict).toBe('exited')
    expect(terminateTree).not.toHaveBeenCalled()
  })

  it('holds unverifiable while the same process stays alive', async () => {
    const claim = claimSidecarProcess(4242, 1, {
      requireIdentityMatch: false,
      readCreationTimeMs: async () => 111,
      isPidAlive: () => true
    })!
    const verdict = await terminateClaimedSidecar(claim, fakeChild(), 1, {
      requireIdentityMatch: false,
      terminateTree: async () => true,
      readCreationTimeMs: async () => 111,
      isPidAlive: () => true,
      verifyPollMs: 1,
      verifyDeadlineMs: 5
    })
    expect(verdict).toBe('unverifiable')
  })

  it('refuses a recycled pid before any pid-addressed kill', async () => {
    const claim = claimSidecarProcess(4242, 1, {
      requireIdentityMatch: true,
      readCreationTimeMs: async () => 111,
      isPidAlive: () => true
    })!
    await claim.identityReady
    const terminateTree = vi.fn(async () => true)
    // The pid now names a different process: no kill may be issued, and
    // the verdict reports our own tree gone rather than success.
    const verdict = await terminateClaimedSidecar(claim, fakeChild(), 1, {
      requireIdentityMatch: true,
      terminateTree,
      readCreationTimeMs: async () => 999,
      isPidAlive: () => true
    })
    expect(verdict).toBe('exited')
    expect(terminateTree).not.toHaveBeenCalled()
  })

  it('fails closed when identity was never captured', async () => {
    const claim = claimSidecarProcess(4242, 1, {
      requireIdentityMatch: true,
      readCreationTimeMs: async () => null,
      isPidAlive: () => true
    })!
    await claim.identityReady
    const terminateTree = vi.fn(async () => true)
    const verdict = await terminateClaimedSidecar(claim, fakeChild(), 1, {
      requireIdentityMatch: true,
      terminateTree,
      readCreationTimeMs: async () => 111,
      isPidAlive: () => true,
      verifyPollMs: 1,
      verifyDeadlineMs: 5
    })
    expect(verdict).toBe('unverifiable')
    expect(terminateTree).not.toHaveBeenCalled()
  })

  it('skips the kill for an already-dead pid on any platform', async () => {
    const claim = claimSidecarProcess(4242, 1, {
      requireIdentityMatch: true,
      readCreationTimeMs: async () => 111,
      isPidAlive: () => false
    })!
    const terminateTree = vi.fn(async () => true)
    const verdict = await terminateClaimedSidecar(claim, fakeChild(), 1, {
      requireIdentityMatch: true,
      terminateTree,
      readCreationTimeMs: async () => null,
      isPidAlive: () => false
    })
    expect(verdict).toBe('exited')
    expect(terminateTree).not.toHaveBeenCalled()
  })

  it('enriches identity before any pid-addressed decision', async () => {
    const events: string[] = []
    let releaseProbe!: () => void
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const claim = claimSidecarProcess(4242, 1, {
      readCreationTimeMs: async () => {
        events.push('probe-start')
        await probeGate
        events.push('probe-done')
        return 111
      },
      isPidAlive: () => false
    })!
    const pending = terminateClaimedSidecar(claim, null, 1, {
      readCreationTimeMs: async () => null,
      isPidAlive: () => {
        events.push('alive-check')
        return false
      }
    })
    // The liveness verdict cannot run ahead of the identity probe.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events).toEqual(['probe-start'])
    releaseProbe()
    expect(await pending).toBe('exited')
    expect(events).toEqual(['probe-start', 'probe-done', 'alive-check'])
  })
})
