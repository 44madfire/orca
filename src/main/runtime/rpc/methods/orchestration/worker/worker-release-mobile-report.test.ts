import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { TERMINAL_SEND_METHODS } from '../../terminal/terminal-send-method'
import { sendTerminalStreamInput } from '../../terminal/terminal-input-delivery'
import { isStreamingMethod, type RpcMethod } from '../../../core'

const h = createOrchestrationWorkerReleaseHarness()
beforeEach(() => h.setup())
afterEach(() => h.cleanup())

it.each(['local', 'ssh'])(
  'a handle-addressed phone report fences %s worker release',
  async (host) => {
    if (host === 'ssh') {
      vi.mocked(h.runtime.getOrchestrationDispatchAuthority).mockImplementation((handle) =>
        handle === 'term_worker'
          ? ({
              terminalHandle: handle,
              paneKey: h.workerPaneKey,
              processIncarnation: 'runtime_test:term_worker:1',
              hostScope: { kind: 'ssh', targetId: 'ssh-1' }
            } as never)
          : null
      )
    }
    const worker = await h.startSettledWorker()
    expect(h.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.host_scope).toContain(host)
    h.runtime.registerPreAllocatedHandleForPty('pty-worker', 'term_worker')
    h.runtime.registerPty('pty-worker', 'repo::worktree', undefined, {
      tabId: 'tab_worker',
      leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })
    vi.mocked(h.runtime.getTerminalPaneKey).mockRestore()
    await expect(
      h.call('orchestration.workerTerminalUserInput', { terminal: 'term_worker' })
    ).resolves.toEqual({ changed: 1 })
    expect(h.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.ownership_state).toBe(
      'user_owned'
    )
    await expect(
      h.call('orchestration.workerTerminalUserInput', { terminal: 'term_worker' })
    ).resolves.toEqual({ changed: 0 })
    await expect(
      h.call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_takeover' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  }
)

it('an unknown handle does not fence another worker or access the database', async () => {
  const worker = await h.startSettledWorker()
  h.runtime.registerPreAllocatedHandleForPty('pty-worker', 'term_worker')
  h.runtime.registerPty('pty-worker', 'repo::worktree', undefined, {
    tabId: 'tab_worker',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  })
  vi.mocked(h.runtime.getTerminalPaneKey).mockRestore()
  const db = vi.spyOn(h.runtime, 'getOrchestrationDb')
  await expect(
    h.call('orchestration.workerTerminalUserInput', { terminal: 'term_missing' })
  ).resolves.toEqual({ changed: 0 })
  expect(db).not.toHaveBeenCalled()
  expect(h.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.ownership_state).toBe('owned')
  await expect(
    h.call('orchestration.workerRelease', { dispatch: worker.dispatchId })
  ).resolves.toMatchObject({ state: 'released' })
})

it.each(['unary', 'stream'])('mobile %s bytes do no orchestration database work', async (lane) => {
  const worker = await h.startSettledWorker()
  const runtime = h.runtime
  runtime.registerPreAllocatedHandleForPty('pty-worker', 'term_worker')
  runtime.registerPty('pty-worker', 'repo::worktree', undefined, {
    tabId: 'tab_worker',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    incarnationId: 'runtime_test:term_worker:1'
  })
  const write = vi.fn(() => true)
  runtime.setPtyController({ write, kill: () => true, getForegroundProcess: async () => null })
  const commit = vi.fn(async () => {})
  vi.spyOn(runtime, 'beginMobileInputFloor').mockReturnValue({ commit, rollback: vi.fn() })
  const dbAccess = vi.spyOn(runtime, 'getOrchestrationDb')
  const takeover = vi.spyOn(h.db, 'markWorkerTerminalUserOwned')
  const prepare = vi.spyOn(h.db.db, 'prepare')
  const exec = vi.spyOn(h.db.db, 'exec')
  const params = {
    terminal: 'term_worker',
    text: 'x',
    client: { id: 'phone', type: 'mobile' as const }
  }
  if (lane === 'stream') {
    await expect(sendTerminalStreamInput(runtime, { ...params, isMobile: true })).resolves.toBe(
      'delivered'
    )
  } else {
    const method = TERMINAL_SEND_METHODS.find(
      (m): m is RpcMethod => m.name === 'terminal.send' && !isStreamingMethod(m)
    )!
    await expect(
      method.handler(method.params!.parse(params) as never, { runtime } as never)
    ).resolves.toMatchObject({ send: { accepted: true } })
  }
  expect(write).toHaveBeenCalledWith('pty-worker', 'x')
  expect(commit).toHaveBeenCalledTimes(1)
  expect(dbAccess).not.toHaveBeenCalled()
  expect(takeover).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  expect(exec).not.toHaveBeenCalled()
  expect(h.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.ownership_state).toBe('owned')
})
