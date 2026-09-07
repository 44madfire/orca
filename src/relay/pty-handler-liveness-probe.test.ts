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

import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
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

  async function probe(id: string): Promise<string> {
    const answer = (await dispatcher.callRequest('pty.probeLiveness', { id })) as {
      status: string
    }
    return answer.status
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
  })

  describe('bookkeeping removals and states that observed nothing', () => {
    it('stays unverifiable after a shutdown removes a record it never saw exit', async () => {
      const { id } = await spawnPty()
      const disposal = handler.dispose()
      await vi.advanceTimersByTimeAsync(8_001)
      await disposal

      expect(handler.activePtyCount).toBe(0)
      expect(await probe(id)).toBe('unknown')
    })

    it('stays unverifiable for an id this relay never minted', async () => {
      expect(await probe(testPtyId(99))).toBe('unknown')
    })

    it('stays unverifiable for an id another relay generation minted', async () => {
      expect(await probe('pty2:some-other-generation:1')).toBe('unknown')
    })

    it.each(['pty-7', '', 'not-a-pty-id'])(
      'stays unverifiable for the id shape %s, which names no generation',
      async (id) => {
        expect(await probe(id)).toBe('unknown')
      }
    )

    it('separates a real exit from a teardown removal in the same shutdown', async () => {
      const exiting = await spawnPty()
      const onExit = mockPtyInstance.onExit.mock.calls.at(-1)?.[0] as (event: {
        exitCode: number
      }) => void
      onExit({ exitCode: 0 })
      const tornDown = await spawnPty()

      const disposal = handler.dispose()
      await vi.advanceTimersByTimeAsync(8_001)
      await disposal

      // Both records are gone from the map; only one of them was ever watched ending.
      expect(await probe(exiting.id)).toBe('exited')
      expect(await probe(tornDown.id)).toBe('unknown')
    })
  })
})
