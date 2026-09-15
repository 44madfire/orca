import { describe, expect, it, vi } from 'vitest'
import {
  createSidecarJobBinder,
  isSidecarJobOwnershipAvailable,
  type SidecarJobNative
} from './plugin-service-windows-job'

function fakeNative(): SidecarJobNative & {
  assigned: number[]
  terminated: number[]
  closed: number[]
} {
  const assigned: number[] = []
  const terminated: number[] = []
  const closed: number[] = []
  let nextHandle = 100
  return {
    assigned,
    terminated,
    closed,
    assignProcessToKillOnCloseJob: (pid: number) => {
      assigned.push(pid)
      return nextHandle++
    },
    terminateSidecarJob: (handle: number) => {
      terminated.push(handle)
      return true
    },
    closeSidecarJob: (handle: number) => {
      closed.push(handle)
    }
  }
}

describe('createSidecarJobBinder', () => {
  it('binds at spawn and terminates by handle', () => {
    const native = fakeNative()
    const reportKill = vi.fn()
    const binder = createSidecarJobBinder(reportKill, () => native)
    expect(binder.available).toBe(true)
    const handle = binder.bind(4242, 1)
    expect(handle).toMatchObject({ pid: 4242, generation: 1 })
    expect(native.assigned).toEqual([4242])
    expect(binder.terminate(handle!, 1)).toBe(true)
    expect(reportKill).toHaveBeenCalledWith(4242)
    binder.release(handle!)
    expect(native.closed).toHaveLength(1)
  })

  it('refuses invalid pids without touching native', () => {
    const native = fakeNative()
    const binder = createSidecarJobBinder(undefined, () => native)
    expect(binder.bind(0, 1)).toBeNull()
    expect(binder.bind(-3, 1)).toBeNull()
    expect(native.assigned).toEqual([])
  })

  it('a stale generation cannot terminate the current tree', () => {
    const native = fakeNative()
    const binder = createSidecarJobBinder(undefined, () => native)
    const handle = binder.bind(4242, 1)!
    // Generation 2 owns pid 4242 now (pid reuse); generation 1's handle is dead.
    expect(binder.terminate(handle, 1)).toBe(true)
    expect(binder.terminate(handle, 2)).toBe(false)
    expect(native.terminated).toHaveLength(1)
  })

  it('a native refusal reads as unavailable, never as success', () => {
    const binder = createSidecarJobBinder(undefined, () => ({
      assignProcessToKillOnCloseJob: () => {
        throw new Error('outer job forbids nesting')
      },
      terminateSidecarJob: () => false,
      closeSidecarJob: () => undefined
    }))
    expect(binder.bind(4242, 1)).toBeNull()
    expect(binder.terminate({ nativeHandle: 1, pid: 4242, generation: 1 }, 1)).toBe(false)
  })

  it('reports unavailable when the build predates the native export', () => {
    const binder = createSidecarJobBinder(undefined, () => null)
    expect(binder.available).toBe(false)
    expect(binder.bind(4242, 1)).toBeNull()
    expect(binder.terminate({ nativeHandle: 1, pid: 4242, generation: 1 }, 1)).toBe(false)
  })

  it('mirrors the loader when no override is given', () => {
    // This environment ships the prebuilt conpty module without the sidecar
    // job export, so production reports honestly unavailable here.
    expect(isSidecarJobOwnershipAvailable()).toBe(false)
  })
})
