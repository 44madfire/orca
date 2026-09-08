import { describe, expect, it, vi } from 'vitest'
import { bindHandleReattachResult } from './reattach-result-handler'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'

vi.mock('../terminal-pane-recovery', () => ({ requestTerminalPaneRecovery: vi.fn() }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

function createSession() {
  const transport = { getPtyId: () => null, connect: vi.fn() }
  return {
    transport,
    pane: { id: 1 },
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      paneTransportsRef: { current: new Map([[1, transport]]) },
      clearTabPtyId: vi.fn()
    },
    terminalRecoveryInstance: { id: 1 },
    terminalRecoveryGeneration: 1,
    transportStreamGeneration: 1,
    authoritativeReattachGeneration: 0,
    isLegacyWorkerAutomaticResumeBlocked: () => false,
    rejectObsoleteDirectSshReattach: () => false,
    clearExitedPanePtyLayoutBinding: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    startFreshColdRestoreAgentResume: vi.fn(),
    handleReattachResult: vi.fn()
  }
}

describe('unverifiable reattach on every host', () => {
  it.each([undefined, { id: 'retained-pty', reattachUnverifiable: true }])(
    'preserves local ownership for %j',
    async (result) => {
      vi.clearAllMocks()
      const session = createSession()
      session.isLegacyWorkerAutomaticResumeBlocked = () => !result
      bindHandleReattachResult(session as never)
      expect(await session.handleReattachResult(result, 'retained-pty')).toBe(false)
      expect(session.deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(session.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
      expect(requestTerminalPaneRecovery).toHaveBeenCalledWith(
        expect.objectContaining({ ptyId: 'retained-pty', reason: 'reattach-unverifiable' })
      )
    }
  )

  it('preserves local ownership when connect throws', async () => {
    vi.clearAllMocks()
    const base = createSession()
    base.transport.connect.mockRejectedValue(new Error('daemon unavailable'))
    const session = {
      ...base,
      runtimeEnvironmentId: 'env-1',
      prepaintParkedSshSnapshot: vi.fn(),
      buildColdRestoreAgentResumeStartup: () => null,
      captureTransportOutputCallbacks: () => ({ generation: 1, callbacks: {} }),
      beginReattachLiveDataDeferral: vi.fn(),
      finishReattachLiveDataDeferral: vi.fn(),
      shouldDeclareHiddenAtSpawn: () => false,
      reportError: vi.fn(),
      armDirectSshPaneRetryTimeout: vi.fn()
    }
    startDeferredSessionReattach(session as never, 'retained-pty')
    await session.armDirectSshPaneRetryTimeout.mock.calls[0][0]
    expect(session.deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(session.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
    expect(requestTerminalPaneRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ ptyId: 'retained-pty', reason: 'reattach-unverifiable' })
    )
  })
})
