import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDeferredSessionReattachChoice } from './deferred-session-reattach-choice'

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ tabsByWorktree: {}, ptyIdsByTabId: {} }) }
}))
vi.mock('../pty-dispatcher', () => ({ getEagerPtyBufferHandle: vi.fn() }))

describe('fenced sleeping paired pane choice', () => {
  afterEach(() => vi.clearAllMocks())
  it('attaches the retained remote leaf without clearing its binding or resuming', () => {
    const id = 'remote:env-1@@terminal-1'
    const session = {
      deps: {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        restoredLeafId: 'leaf-1',
        restoredPtyIdByLeafId: { 'leaf-1': id },
        paneTransportsRef: { current: new Map() },
        clearTabPtyId: vi.fn()
      },
      pane: { id: 1 },
      getSleepingRecordForPane: () => ({}),
      isLegacyWorkerAutomaticResumeBlocked: () => true,
      buildColdRestoreAgentResumeStartup: vi.fn(),
      syncPanePtyLayoutBinding: vi.fn(),
      clearPaneMode2031State: vi.fn(),
      clearHiddenOutputRestoreState: vi.fn(),
      captureTransportOutputCallbacks: () => ({ callbacks: {} }),
      transport: { attach: vi.fn(), getPtyId: () => id },
      bindActivePanePty: vi.fn(),
      registerPaneSerializerFor: vi.fn(),
      reportError: vi.fn(),
      startFreshSpawn: vi.fn(),
      startFreshColdRestoreAgentResume: vi.fn()
    }
    runDeferredSessionReattachChoice(session as never)
    expect(session.transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: id })
    )
    expect(session.deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(session.syncPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(session.startFreshSpawn).not.toHaveBeenCalled()
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  })
})
