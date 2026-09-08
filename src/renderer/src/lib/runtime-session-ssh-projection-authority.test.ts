import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '../store/slices/store-test-helpers'
import { buildWorkspaceSessionPayload } from './workspace-session'
import { importRemoteWorkspaceSession } from '../../../shared/remote-workspace-session-projection'
import { mergeDirectSshRemoteWorkspaceSession } from '../hooks/remote-workspace-session-merge'
import { refreshLegacyWorkerResumeFences } from './legacy-worker-resume-fence-refresh'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
const initial = useAppStore.getState()
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})
it.each(['acquire', 'retire'] as const)(
  'SSH projection cannot consume authoritative %s reply',
  async (kind) => {
    const worktreeId = 'folder:legacy',
      paneKey = 'target:11111111-2222-4333-8444-555555555555'
    const tab = makeTab({ id: 'target', worktreeId })
    const record = {
      paneKey,
      tabId: 'target',
      worktreeId,
      agent: 'claude' as const,
      providerSession: { key: 'session_id' as const, id: 'session-legacy' },
      prompt: 'continue',
      state: 'working' as const,
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live' as const
    }
    useAppStore.setState({
      tabsByWorktree: { [worktreeId]: [tab] },
      sleepingAgentSessionsByPaneKey: { [paneKey]: record },
      legacyWorkerResumeFencesByPaneKey: kind === 'retire' ? { [paneKey]: true } : {}
    })
    let resolve!: (v: Record<string, true>) => void
    const get = vi.fn(() => new Promise<Record<string, true>>((r) => (resolve = r)))
    vi.stubGlobal('window', { api: { app: { getLegacyWorkerResumeFences: get } } })
    const pending = refreshLegacyWorkerResumeFences()
    const remote = importRemoteWorkspaceSession(
      {
        activeWorktreePath: null,
        activeTabId: null,
        tabsByWorktreePath: { '/legacy': [{ ...tab, worktreePath: '/legacy' }] },
        terminalLayoutsByTabId: {}
      },
      { resolveWorktreeId: () => worktreeId, executionHostId: 'ssh:target' }
    )
    const state = useAppStore.getState()
    const merged = mergeDirectSshRemoteWorkspaceSession(
      buildWorkspaceSessionPayload(state),
      remote,
      new Set([worktreeId]),
      state.tabsByWorktree,
      new Set(),
      'ssh:target',
      1
    )
    expect(merged.legacyWorkerResumeFencesByPaneKey).toBeUndefined()
    useAppStore.getState().hydrateWorkspaceSession(merged, {
      replaceWorkspaceKeys: [worktreeId],
      additionalValidWorkspaceKeys: [worktreeId]
    })
    resolve(kind === 'acquire' ? { [paneKey]: true } : {})
    await pending
    const count = resumeSleepingAgentSessionsForWorktree(worktreeId)
    console.log(kind, {
      count,
      fences: useAppStore.getState().legacyWorkerResumeFencesByPaneKey,
      recordPresent: !!useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey],
      tabs: useAppStore.getState().tabsByWorktree[worktreeId]?.map((t) => t.id),
      claims: useAppStore.getState().automaticAgentResumeClaimsByTabId
    })
    expect(get).toHaveBeenCalledTimes(1)
    expect(count).toBe(kind === 'acquire' ? 0 : 1)
  }
)
