import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AppState } from '../types'
import { buildSleepingAgentSessionData } from '@/lib/workspace-session-sleeping-agents'
import { createTestStore, makeTab } from './store-test-helpers'

const NOW = 1_800_000_000_000
const PANE_KEY = 'tab-1:leaf-1'

function liveWorkerEntry(state: AgentStatusEntry['state'] = 'working'): AgentStatusEntry {
  return {
    state,
    prompt: 'finish the task',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'codex',
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    providerSession: { key: 'session_id', id: 'session-1' }
  }
}

function fencedStore() {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] },
    agentStatusByPaneKey: { [PANE_KEY]: liveWorkerEntry() },
    legacyWorkerResumeFencesByPaneKey: { [PANE_KEY]: true }
  } as Partial<AppState>)
  return store
}

// The worker settles while its tab is still open, so there is no sleeping record to carry a flag.
// The fence is runtime-authored session state keyed by pane, so it exists for that pane regardless,
// and no renderer writer has to remember to preserve it.
describe('a resume fence for a pane with no sleeping record', () => {
  it('survives every record rebuild, because no record carries it', () => {
    const store = fencedStore()

    store.getState().captureAllSleepingAgentSessions('quit')
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'done', prompt: 'finish the task', agentType: 'codex' } as never,
        undefined,
        { updatedAt: NOW + 1 },
        { tabId: 'tab-1', worktreeId: 'wt-1' } as never,
        { providerSession: { key: 'session_id', id: 'session-1' } }
      )

    expect(store.getState().legacyWorkerResumeFencesByPaneKey[PANE_KEY]).toBe(true)
  })

  // Only the runtime writes the fence; the renderer installs whatever main published.
  it('is retired only by the runtime replacing the set', () => {
    const store = fencedStore()

    store.setState({ legacyWorkerResumeFencesByPaneKey: {} })

    expect(store.getState().legacyWorkerResumeFencesByPaneKey).toEqual({})
  })

  // Hydration installs the runtime's set rather than merging it, so a fence retired while this
  // renderer was down does not survive the read that is supposed to replace it.
  it('replaces a stale local fence on hydration rather than merging', () => {
    const store = fencedStore()

    store.getState().hydrateWorkspaceSession(
      {
        activeRepoId: null,
        activeWorktreeId: null,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        legacyWorkerResumeFencesByPaneKey: {}
      },
      undefined
    )

    expect(store.getState().legacyWorkerResumeFencesByPaneKey).toEqual({})
  })

  // Compatibility projection belongs to main, so outgoing renderer records stay untouched.
  it('does not project runtime fences onto outgoing records', () => {
    const store = fencedStore()
    store.getState().captureAllSleepingAgentSessions('quit')
    const snapshot = store.getState()
    expect(
      snapshot.sleepingAgentSessionsByPaneKey[PANE_KEY]?.automaticResumeBlockedBy
    ).toBeUndefined()

    const projected = buildSleepingAgentSessionData(snapshot)

    expect(
      projected.sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.automaticResumeBlockedBy
    ).toBeUndefined()
  })

  it('strips a stale projection once the runtime retires the fence', () => {
    const store = fencedStore()
    store.getState().captureAllSleepingAgentSessions('quit')
    store.setState({ legacyWorkerResumeFencesByPaneKey: {} })

    const projected = buildSleepingAgentSessionData(store.getState())

    expect(
      projected.sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.automaticResumeBlockedBy
    ).toBeUndefined()
  })
})
