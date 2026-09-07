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

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

describe('review writer fence race', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
  })
  it('preserves a fence delivered during manual sleep stop', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const leaf = '11111111-1111-4111-8111-111111111111'
    const pane = `tab-1:${leaf}`
    seedStore(store, {
      worktreesByRepo: { repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })] },
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId: 'pty-agent' })] },
      ptyIdsByTabId: { 'tab-1': ['pty-agent'] }
    })
    store
      .getState()
      .setAgentStatus(
        pane,
        { state: 'working', prompt: 'worker', agentType: 'claude' },
        'Claude',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'session-1' } }
      )
    mockApi.pty.kill.mockImplementationOnce(async () => {
      store.getState().setLegacyWorkerResumeFences({ [pane]: true })
      expect(store.getState().legacyWorkerResumeFencesByPaneKey[pane]).toBe(true)
    })
    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
    expect(mockApi.pty.kill).toHaveBeenCalled()
    expect(store.getState().legacyWorkerResumeFencesByPaneKey[pane]).toBe(true)
    expect(store.getState().legacyWorkerResumeFencesByPaneKey[pane]).toBe(true)
  })
  it('preserves a fence delivered during a failed hibernation stop', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const leaf = '11111111-1111-4111-8111-111111111111'
    const pane = `tab-1:${leaf}`
    seedStore(store, {
      worktreesByRepo: { repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })] },
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId: 'pty-agent' })] },
      ptyIdsByTabId: { 'tab-1': ['pty-agent'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: 'pty-agent' }
        }
      }
    })
    store
      .getState()
      .setAgentStatus(
        pane,
        { state: 'done', prompt: 'worker', agentType: 'claude' },
        'Claude',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'session-1' } }
      )
    mockApi.pty.kill.mockImplementationOnce(async () => {
      store.getState().setLegacyWorkerResumeFences({ [pane]: true })
      expect(store.getState().legacyWorkerResumeFencesByPaneKey[pane]).toBe(true)
      throw new Error('kill_failed')
    })
    await expect(
      store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
        paneKey: pane,
        tabId: 'tab-1',
        leafId: leaf,
        ptyId: 'pty-agent'
      })
    ).rejects.toThrow('kill_failed')
    expect(mockApi.pty.kill).toHaveBeenCalled()
    expect(store.getState().legacyWorkerResumeFencesByPaneKey[pane]).toBe(true)
    expect(store.getState().legacyWorkerResumeFencesByPaneKey[pane]).toBe(true)
  })
})
