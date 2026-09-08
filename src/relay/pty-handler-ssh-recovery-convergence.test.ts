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
import {
  beginPtyHandlerTest,
  endPtyHandlerTest,
  type MockDispatcher
} from './pty-handler-test-harness'
import type { PtyHandler } from './pty-handler'
import { SshPtyProvider } from '../main/providers/ssh-pty-provider'
import { toAppSshPtyId } from '../shared/ssh-pty-id'
import { sshProviders } from '../main/ipc/pty/provider/registry'
import { probePtyLivenessFromRuntimeController } from '../main/ipc/pty/runtime/operations'
import { reconcileLegacyWorkerCandidate } from '../main/runtime/runtime-legacy-worker-terminal-recovery-candidate'
import type { LegacyWorkerRecoveryResolution } from '../main/runtime/runtime-legacy-worker-terminal-recovery-types'
import { OrchestrationDb } from '../main/runtime/orchestration/db'
const connection = 'review-convergence'
const deps = { getLocalPtyProviderStartupPromise: () => undefined } as never

describe('SSH recovery convergence', () => {
  let handler: PtyHandler
  let dispatcher: MockDispatcher
  let originalPlatform: PropertyDescriptor | undefined
  let provider: SshPtyProvider
  let request: ReturnType<typeof vi.fn>
  beforeEach(() => {
    ;({ handler, dispatcher, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    request = vi.fn((method: string, params: Record<string, unknown>) =>
      dispatcher.callRequest(method, params)
    )
    provider = new SshPtyProvider(connection, {
      request,
      onNotification: () => () => {},
      onRequest: () => () => {}
    } as never)
    sshProviders.set(connection, provider)
  })
  afterEach(async () => {
    sshProviders.delete(connection)
    provider.dispose()
    await endPtyHandlerTest(handler, originalPlatform)
  })
  async function candidateResult(ptyId: string, dispatchId = 'review-worker') {
    const pendingResolutions: LegacyWorkerRecoveryResolution[] = []
    const deferredDispatchIds = new Set<string>()
    await reconcileLegacyWorkerCandidate({
      controller: {} as never,
      ports: {
        isPtyProvenAbsent: async () =>
          (await probePtyLivenessFromRuntimeController(deps, ptyId)) === false
      } as never,
      options: { connectionId: connection },
      candidate: { dispatchId, ptyId } as never,
      workspace: {} as never,
      resolvedWorktrees: [],
      inventory: { livePtyIds: new Set() } as never,
      pendingResolutions,
      deferredDispatchIds
    })
    return { pendingResolutions, deferredDispatchIds }
  }
  it.each([false, true])(
    'does not certify an unexited shutdown record; sibling kill failure=%s',
    async (sibling) => {
      const { id } = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }
      const failedKill = vi.fn<() => void>(() => {
        throw new Error('host refused kill')
      })
      if (sibling) {
        mockPtySpawn.mockReturnValueOnce({ ...mockPtyInstance, kill: failedKill })
        await dispatcher.callRequest('pty.spawn', {})
      }
      const disposal = handler.dispose().catch((error: Error) => error)
      await vi.advanceTimersByTimeAsync(8001)
      const outcome = await disposal
      if (sibling) {
        expect(outcome).toMatchObject({ message: 'host refused kill' })
        failedKill.mockImplementation(() => {})
      }
      expect(() => process.kill(process.pid, 0)).not.toThrow()
      expect(dispatcher._notifications.filter((n) => n.method === 'pty.exit')).toEqual([])
      const appId = toAppSshPtyId(connection, id)
      expect(await probePtyLivenessFromRuntimeController(deps, appId)).toBeNull()
      const result = await candidateResult(appId)
      expect(result.pendingResolutions).toEqual([])
      expect([...result.deferredDispatchIds]).toEqual(['review-worker'])
    }
  )
  it('recovers a worker after the connected relay observed its physical exit while the client was absent', async () => {
    const { id } = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }
    const exit = mockPtyInstance.onExit.mock.calls.at(-1)![0] as (event: {
      exitCode: number
    }) => void
    exit({ exitCode: 0 })
    expect(handler.activePtyCount).toBe(0)
    expect(dispatcher._notifications.some((n) => n.method === 'pty.exit')).toBe(true)
    expect(
      await dispatcher.callRequest('pty.listProcesses', { includeForegroundProcessEvidence: false })
    ).toEqual([])
    const appId = toAppSshPtyId(connection, id)
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({ spec: 'recover terminated SSH worker' })
      const start = {
        taskId: task.id,
        startOptions: {},
        creator: { kind: 'system' as const },
        maxDepth: 9
      }
      const { dispatch } = db.createStartingWorkerDispatch(start)
      db.markWorkerDispatchReady(dispatch.id)
      const rounds: Awaited<ReturnType<typeof candidateResult>>[] = []
      for (let sweep = 0; sweep < 3; sweep++) {
        rounds.push(await candidateResult(appId, dispatch.id))
      }
      expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('ready')
      expect(() => db.updateTaskStatus(task.id, 'ready')).toThrow()
      expect(() => db.createStartingWorkerDispatch(start)).toThrow()
      // The reachable owner needs to answer this instead of silently deferring every sweep.
      expect(rounds.at(-1)?.pendingResolutions).toEqual([
        { candidate: { dispatchId: dispatch.id, ptyId: appId }, resolution: 'exited' }
      ])
    } finally {
      db.close()
    }
  })
})
