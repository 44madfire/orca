import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { TERMINAL_SEND_METHODS } from '../../terminal/terminal-send-method'
import { isStreamingMethod, type RpcMethod } from '../../../core'
import { sendTerminalStreamInput } from '../../terminal/terminal-input-delivery'

const harness = createOrchestrationWorkerReleaseHarness()
beforeEach(() => harness.setup())
afterEach(() => harness.cleanup())

it.each(['stream', 'unary'])(
  'fences the first legacy phone %s key during renderer reload',
  async (lane) => {
    const runtime = harness.runtime
    const ptyId = 'pty-reload-worker'
    const tabId = 'tab_worker'
    const leafId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const handle = runtime.preAllocateHandleForPty(ptyId)
    const writes: string[] = []
    runtime.setPtyController({
      write: (_id, text) => {
        writes.push(text)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty(ptyId, 'repo::worktree', undefined, {
      tabId,
      leafId,
      incarnationId: 'incarnation-1'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: 'repo::worktree',
          title: 'worker',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: 'repo::worktree',
          leafId,
          paneRuntimeId: 1,
          ptyId
        }
      ]
    })
    vi.mocked(runtime.createTerminal).mockResolvedValue({
      handle,
      worktreeId: 'repo::worktree'
    } as never)
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((h) =>
      h === 'term_coord' ? harness.coordinatorPaneKey : h === handle ? harness.workerPaneKey : null
    )
    vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('runtime_test:worker:1')
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockImplementation((h) =>
      h === handle
        ? ({
            terminalHandle: handle,
            paneKey: harness.workerPaneKey,
            processIncarnation: 'runtime_test:worker:1',
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'beginMobileInputFloor').mockReturnValue({
      commit: async () => {},
      rollback: () => {}
    })
    vi.spyOn(runtime, 'getDriver').mockReturnValue({
      kind: 'mobile',
      clientId: 'legacy-phone'
    })
    const worker = await harness.startSettledWorker()
    expect(runtime.resolveLiveLeafForHandle(handle)?.ptyId).toBe(ptyId)
    expect(runtime.markRendererReloading(1)).not.toBeNull()
    expect((runtime as unknown as { handles: Map<string, unknown> }).handles.has(handle)).toBe(
      false
    )
    if (lane === 'stream') {
      expect(
        await sendTerminalStreamInput(runtime, {
          terminal: handle,
          text: 'x',
          client: undefined,
          isMobile: false
        })
      ).toBe('delivered')
    } else {
      const method = TERMINAL_SEND_METHODS.find(
        (m): m is RpcMethod => m.name === 'terminal.send' && !isStreamingMethod(m)
      )!
      expect(
        await method.handler(
          method.params!.parse({ terminal: handle, text: 'x' }) as never,
          { runtime } as never
        )
      ).toMatchObject({ send: { accepted: true } })
    }
    expect(writes).toEqual(['x'])
    expect(runtime.resolveLiveLeafForHandle(handle)?.ptyId).toBe(ptyId)
    const state = harness.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.ownership_state
    const release = await harness.call('orchestration.workerRelease', {
      dispatch: worker.dispatchId
    })
    expect(state).toBe('user_owned')
    expect(release).toMatchObject({
      state: 'retained',
      reason: 'user_takeover'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  }
)
