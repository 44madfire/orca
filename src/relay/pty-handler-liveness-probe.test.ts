// Which removals of a PTY record observed the process end, and which are bookkeeping. Only the
// relay knows, so only the relay may answer, and it certifies an exit from an observation alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    process: 'zsh',
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import { OBSERVED_PTY_EXIT_HISTORY, type PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createMockDispatcher,
  createPtyRequestHelpers,
  createTestPtyHandler,
  endPtyHandlerTest,
  testPtyId
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

const UNREACHABLE_PID = 424_242

describe('PtyHandler.probeLiveness', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const { spawnPty } = createPtyRequestHelpers(() => dispatcher)

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  async function probe(id: string, on: MockDispatcher = dispatcher): Promise<string> {
    const answer = (await on.callRequest('pty.probeLiveness', { id })) as { status: string }
    return answer.status
  }

  /** Fire the exit node-pty reported for the most recently spawned PTY. */
  function reportExitOfLatestPty(): void {
    const onExit = mockPtyInstance.onExit.mock.calls.at(-1)?.[0] as (event: {
      exitCode: number
    }) => void
    onExit({ exitCode: 0 })
  }

  /**
   * No current teardown leaves a disposed record in the pool — each disposer removes it in the
   * same synchronous step — so the state is built here rather than left to a future one. The
   * probe's disposed guard and the listing's torn-down sweep both exist for exactly that teardown,
   * and both must keep answering unverifiable when it arrives.
   */
  function tearDownRecordWithoutRemovingIt(id: string): void {
    const pool = (handler as unknown as { ptys: Map<string, { disposed: boolean }> }).ptys
    const managed = pool.get(id)
    if (!managed) {
      throw new Error(`no record for ${id}`)
    }
    managed.disposed = true
  }

  /** Tear a record down and let the listing sweep it away; nothing watched the process end. */
  async function forgetRecordWithoutObservingItsExit(id: string): Promise<void> {
    tearDownRecordWithoutRemovingIt(id)
    await dispatcher.callRequest('pty.listProcesses', { includeForegroundProcessEvidence: false })
  }

  /** The state `pty.revive` re-creates a process from, for an id this relay did not mint. */
  function serializedState(id: string): string {
    return JSON.stringify([{ id, pid: process.pid, cols: 80, rows: 24, cwd: process.cwd() }])
  }

  /** A shutdown whose sibling refuses to die: the aggregate fails and the relay keeps serving. */
  async function failedShutdownThatKeepsTheRelayServing(): Promise<void> {
    const failedKill = vi.fn<() => void>(() => {
      throw new Error('host refused kill')
    })
    mockPtySpawn.mockReturnValueOnce({ ...mockPtyInstance, kill: failedKill })
    await spawnPty()
    const disposal = handler.dispose().catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(8_001)
    expect(await disposal).toMatchObject({ message: 'host refused kill' })
    // Let the fixture be cleaned up now that the refusal has been asserted.
    failedKill.mockImplementation(() => {})
  }

  describe('observed exits', () => {
    it('answers live while the relay owns a running record', async () => {
      const { id } = await spawnPty()

      expect(await probe(id)).toBe('live')
    })

    it('certifies the exit node-pty reported', async () => {
      const { id } = await spawnPty()
      const onExit = mockPtyInstance.onExit.mock.calls.at(-1)?.[0] as (event: {
        exitCode: number
        signal?: number
      }) => void
      onExit({ exitCode: 0 })

      expect(await probe(id)).toBe('exited')
    })

    it('certifies an exit it proves by probing the pid, and keeps certifying it', async () => {
      mockPtySpawn.mockReturnValueOnce({ ...mockPtyInstance, pid: UNREACHABLE_PID })
      const { id } = await spawnPty()

      // The shell ended without node-pty reporting it; the pid answers ESRCH.
      expect(await probe(id)).toBe('exited')
      // The first probe reaped the record, so the second has only the observation to go on — and
      // the recovery sweep that drives this asks again on every pass.
      expect(await probe(id)).toBe('exited')
    })

    it('certifies an exit node-pty reported after the shutdown wait had given up', async () => {
      const { id } = await spawnPty()
      const exiting = mockPtyInstance.onExit.mock.calls.at(-1)?.[0] as (event: {
        exitCode: number
      }) => void

      await failedShutdownThatKeepsTheRelayServing()

      // The record was removed on a timeout, which watched nothing.
      expect(await probe(id)).toBe('unverifiable')
      exiting({ exitCode: 0 })
      // Disposal is bookkeeping; the callback that follows it is still this relay watching this
      // process end, and losing it is what left these workers unverifiable forever.
      expect(await probe(id)).toBe('exited')
    })
  })

  describe('bookkeeping removals and states that observed nothing', () => {
    it('stays unverifiable after a shutdown removes a record it never saw exit', async () => {
      const { id } = await spawnPty()
      const disposal = handler.dispose()
      await vi.advanceTimersByTimeAsync(8_001)
      await disposal

      expect(handler.activePtyCount).toBe(0)
      expect(await probe(id)).toBe('unverifiable')
    })

    it('stays unverifiable for an id this relay never minted', async () => {
      expect(await probe(testPtyId(99))).toBe('unverifiable')
    })

    it('stays unverifiable for an id another relay generation minted', async () => {
      const { id } = await spawnPty()
      reportExitOfLatestPty()
      expect(await probe(id)).toBe('exited')

      // Ledger keys are the whole ids of records this relay held, so no number of exits it has
      // watched can put another generation's id in it.
      expect(await probe('pty2:some-other-generation:1')).toBe('unverifiable')
    })

    it.each(['pty-7', '', 'not-a-pty-id'])(
      'stays unverifiable for the id shape %s, which names no generation',
      async (id) => {
        expect(await probe(id)).toBe('unverifiable')
      }
    )

    it('separates a real exit from a teardown removal in the same shutdown', async () => {
      const exiting = await spawnPty()
      reportExitOfLatestPty()
      const tornDown = await spawnPty()

      const disposal = handler.dispose()
      await vi.advanceTimersByTimeAsync(8_001)
      await disposal

      // Both records are gone from the map; only one of them was ever watched ending.
      expect(await probe(exiting.id)).toBe('exited')
      expect(await probe(tornDown.id)).toBe('unverifiable')
    })

    it('keeps a record a shutdown could not kill live, rather than retiring it on paper', async () => {
      mockPtySpawn.mockReturnValueOnce({
        ...mockPtyInstance,
        kill: vi.fn(() => {
          throw new Error('host refused kill')
        })
      })
      const { id } = await spawnPty()

      const disposal = handler.dispose().catch((error: Error) => error)
      await vi.advanceTimersByTimeAsync(8_001)
      await disposal

      expect(await probe(id)).toBe('live')
    })

    it('stays unverifiable while a record is mid-teardown', async () => {
      const { id } = await spawnPty()
      tearDownRecordWithoutRemovingIt(id)

      // The pid is this test process, so without the guard the record reads as a live PTY.
      expect(await probe(id)).toBe('unverifiable')
    })

    it('stays unverifiable after the listing sweeps a torn-down record away', async () => {
      const { id } = await spawnPty()
      tearDownRecordWithoutRemovingIt(id)

      await dispatcher.callRequest('pty.listProcesses', { includeForegroundProcessEvidence: false })

      expect(handler.activePtyCount).toBe(0)
      expect(await probe(id)).toBe('unverifiable')
    })

    it('never certifies an exit from a worktree removal it could not prove', async () => {
      const { id } = await spawnPty({ cwd: process.cwd() })

      // The removal asks for the kill; nothing reports the process ending, so the record stays.
      const removal = handler.shutdownForWorktreePath(process.cwd()).catch((error: Error) => error)
      await vi.advanceTimersByTimeAsync(8_001)
      await removal

      expect(await probe(id)).toBe('live')
    })

    it('stays unverifiable while a revive holds the id, and answers for the new record after', async () => {
      const { id } = await spawnPty({ cwd: process.cwd() })
      const state = (await dispatcher.callRequest('pty.serialize', { ids: [id] })) as string
      reportExitOfLatestPty()
      expect(await probe(id)).toBe('exited')

      // The revive is about to put a different process on this id, so the observation it would
      // otherwise be certified from describes a process that no longer occupies it.
      const revived = dispatcher.callRequest('pty.revive', { state })
      expect(await probe(id)).toBe('unverifiable')
      await revived

      expect(await probe(id)).toBe('live')
    })

    it('evicts observations in the order it made them, not the order it was asked', async () => {
      let oldest = ''
      let newest = ''
      for (let index = 0; index < OBSERVED_PTY_EXIT_HISTORY; index++) {
        const { id } = await spawnPty()
        reportExitOfLatestPty()
        oldest ||= id
        newest = id
      }

      // Asking about the oldest entry at the cap must not renew it: retention is observation
      // order, so the next observation still pushes exactly this one out.
      expect(await probe(oldest)).toBe('exited')
      expect(await probe(newest)).toBe('exited')
      const overflowing = await spawnPty()
      reportExitOfLatestPty()

      expect(await probe(overflowing.id)).toBe('exited')
      // Evicted, not remembered as absent: a forgotten observation is unverifiable, never exited.
      expect(await probe(oldest)).toBe('unverifiable')
    })

    it('forgets every observation when the relay restarts, even under the same mint epoch', async () => {
      const { id } = await spawnPty()
      reportExitOfLatestPty()
      expect(await probe(id)).toBe('exited')

      // The ledger is per process by design. A relay that restarts between the observation and the
      // question has nothing to certify from, which is the fail-closed direction.
      const restartedDispatcher = createMockDispatcher()
      const restarted = createTestPtyHandler(restartedDispatcher)
      try {
        expect(await probe(id, restartedDispatcher)).toBe('unverifiable')
      } finally {
        await restarted.dispose({ waitForPhysicalExit: false }).catch(() => {})
      }
    })
  })

  describe('incarnations sharing one id, which `pty.revive` re-creates a process under', () => {
    it.each(['pty-7', 'pty2:previous-generation:99'])(
      'certifies the exit of the process it revived under %s, and only for itself',
      async (id) => {
        await dispatcher.callRequest('pty.revive', { state: serializedState(id) })
        expect(await probe(id)).toBe('live')

        reportExitOfLatestPty()

        expect(await probe(id)).toBe('exited')
        // Reviving is what put the id in this relay's hands; whatever its shape, it names nothing
        // on a relay that never held it.
        const otherDispatcher = createMockDispatcher()
        const other = createTestPtyHandler(otherDispatcher)
        try {
          expect(await probe(id, otherDispatcher)).toBe('unverifiable')
        } finally {
          await other.dispose({ waitForPhysicalExit: false }).catch(() => {})
        }
      }
    )

    it('stays unverifiable for an id whose revive never created a record', async () => {
      mockPtySpawn.mockImplementationOnce(() => {
        throw new Error('spawn refused')
      })

      await expect(
        dispatcher.callRequest('pty.revive', { state: serializedState('pty-77') })
      ).rejects.toThrow('spawn refused')

      expect(await probe('pty-77')).toBe('unverifiable')
    })

    it('does not certify a revived process with the exit of the one it replaced', async () => {
      const id = 'pty-7'
      await dispatcher.callRequest('pty.revive', { state: serializedState(id) })
      reportExitOfLatestPty()
      expect(await probe(id)).toBe('exited')

      // Admitting a second incarnation clears that observation: it described the process this one
      // replaced, so the id starts again with nothing to certify from.
      await dispatcher.callRequest('pty.revive', { state: serializedState(id) })
      expect(await probe(id)).toBe('live')

      await failedShutdownThatKeepsTheRelayServing()

      // The revived record left the pool on a timeout, and its process is still running.
      expect(() => process.kill(process.pid, 0)).not.toThrow()
      expect(await probe(id)).toBe('unverifiable')
    })

    it('does not let a superseded incarnation certify the id once both records are gone', async () => {
      const id = 'pty-7'
      await dispatcher.callRequest('pty.revive', { state: serializedState(id) })
      const supersededExit = mockPtyInstance.onExit.mock.calls.at(-1)?.[0] as (event: {
        exitCode: number
      }) => void
      await forgetRecordWithoutObservingItsExit(id)
      await dispatcher.callRequest('pty.revive', { state: serializedState(id) })
      await forgetRecordWithoutObservingItsExit(id)

      // The first process really did end. The id belongs to a later one that nothing watched end,
      // so an empty pool is not permission for this callback to answer for it.
      supersededExit({ exitCode: 0 })

      expect(await probe(id)).toBe('unverifiable')
    })
  })
})
