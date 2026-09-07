import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import {
  applySleepRuntimeRpcDefault,
  createStoreCascadesMockApi
} from './store-cascades-test-harness'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = createStoreCascadesMockApi()

const WORKTREE_ID = 'repo1::/path/wt1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function storeWithAgentPane(state: 'working' | 'done') {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTab({ id: 'tab-1', worktreeId: WORKTREE_ID, ptyId: 'pty-agent' })]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-agent'] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-agent' }
      }
    }
  })
  store
    .getState()
    .setAgentStatus(
      PANE_KEY,
      { state, prompt: 'worker', agentType: 'claude' },
      'Claude',
      { updatedAt: 2000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: WORKTREE_ID },
      { providerSession: { key: 'session_id', id: 'session-1' } }
    )
  return store
}

const fenceOf = (store: ReturnType<typeof createTestStore>): string | undefined =>
  store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.automaticResumeBlockedBy

// Both stop paths capture the record before awaiting the kill and commit that capture afterwards.
// A fence delivered while the kill is in flight lands on the live record, and committing the older
// capture verbatim erased it — leaving a settled worker automatically resumable again.
describe('a resume fence delivered while a pane stop is in flight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
  })

  it('survives the manual-sleep capture committed after the stop', async () => {
    const store = storeWithAgentPane('working')
    mockApi.pty.kill.mockImplementationOnce(async () => {
      store.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, true)
    })

    await store.getState().shutdownWorktreeTerminals(WORKTREE_ID, { keepIdentifiers: true })

    expect(mockApi.pty.kill).toHaveBeenCalled()
    expect(store.getState().automaticResumeBlockedPaneKeys[PANE_KEY]).toBe(true)
    expect(fenceOf(store)).toBe('legacy-orchestration-worker')
  })

  it('survives the rollback of a hibernation stop that threw', async () => {
    const store = storeWithAgentPane('done')
    mockApi.pty.kill.mockImplementationOnce(async () => {
      store.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, true)
      throw new Error('kill_failed')
    })

    await expect(
      store.getState().shutdownCompletedAgentPaneForHibernation(WORKTREE_ID, {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        leafId: LEAF_ID,
        ptyId: 'pty-agent'
      })
    ).rejects.toThrow('kill_failed')

    expect(store.getState().automaticResumeBlockedPaneKeys[PANE_KEY]).toBe(true)
    expect(fenceOf(store)).toBe('legacy-orchestration-worker')
  })

  // Control: the commit re-reads state, so a lift that lands during the stop is honoured too — the
  // writer follows current authority rather than pinning whatever the capture happened to hold.
  it('drops a fence the runtime retires during the stop', async () => {
    const store = storeWithAgentPane('working')
    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, true)
    expect(fenceOf(store)).toBe('legacy-orchestration-worker')
    mockApi.pty.kill.mockImplementationOnce(async () => {
      store.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, false)
    })

    await store.getState().shutdownWorktreeTerminals(WORKTREE_ID, { keepIdentifiers: true })

    expect(store.getState().automaticResumeBlockedPaneKeys[PANE_KEY]).toBeUndefined()
    expect(fenceOf(store)).toBeUndefined()
  })
})
