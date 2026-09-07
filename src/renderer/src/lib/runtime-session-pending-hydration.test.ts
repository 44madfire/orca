import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { refreshLegacyWorkerResumeFences } from './legacy-worker-resume-fence-refresh'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
const initial = useAppStore.getState()
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})
it.each(['canonical', 'legacy'] as const)(
  'cannot auto-resume %s protected records while hydration waits behind a read',
  async (kind) => {
    let resolve!: (value: Record<string, true>) => void
    vi.stubGlobal('window', {
      api: {
        app: {
          getLegacyWorkerResumeFences: () =>
            new Promise<Record<string, true>>((done) => {
              resolve = done
            })
        }
      }
    })
    const pending = refreshLegacyWorkerResumeFences()
    const paneKey = 'tab-legacy:11111111-2222-4333-8444-555555555555'
    const record = {
      paneKey,
      tabId: 'tab-legacy',
      worktreeId: 'folder:legacy',
      agent: 'claude' as const,
      providerSession: { key: 'session_id' as const, id: 'session-legacy' },
      prompt: 'continue legacy work',
      state: 'working' as const,
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live' as const,
      ...(kind === 'legacy'
        ? { automaticResumeBlockedBy: 'legacy-orchestration-worker' as const }
        : {})
    }
    useAppStore.getState().hydrateWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        sleepingAgentSessionsByPaneKey: { [paneKey]: record },
        ...(kind === 'canonical'
          ? { legacyWorkerResumeFencesByPaneKey: { [paneKey]: true as const } }
          : {})
      },
      { additionalValidWorkspaceKeys: [folderWorkspaceKey('legacy')] }
    )
    const count = resumeSleepingAgentSessionsForWorktree('folder:legacy')
    const observed = {
      count,
      tabs: useAppStore.getState().tabsByWorktree['folder:legacy']?.map((tab) => tab.id),
      claims: useAppStore.getState().automaticAgentResumeClaimsByTabId,
      recordStillPresent: !!useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]
    }
    resolve({})
    await pending
    console.log(kind, observed)
    expect(count).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBe(record)
  }
)
