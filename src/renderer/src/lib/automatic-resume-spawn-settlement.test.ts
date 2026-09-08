vi.mock('@/components/terminal-pane/terminal-pane-recovery', () => ({
  requestTerminalPaneRecovery: vi.fn()
}))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { settleAutomaticResumeSpawn } from './automatic-resume-spawn-settlement'
import { bindHandleReattachResult } from '@/components/terminal-pane/pty-connection/reattach-result-handler'
import { buildWorkspaceSessionPayload } from './workspace-session'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const initial = useAppStore.getState()
afterEach(() => useAppStore.setState(initial, true))

function queueResume() {
  const record: SleepingAgentSessionRecord = {
    paneKey: 'historical:11111111-1111-4111-8111-111111111111',
    tabId: 'historical',
    worktreeId: 'folder-worker',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'fenced-worker-session' },
    state: 'working',
    prompt: 'continue',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live'
  }
  useAppStore.setState({
    tabsByWorktree: { 'folder-worker': [] },
    legacyWorkerResumeFencesByPaneKey: {},
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  })
  expect(resumeSleepingAgentSessionsForWorktree(record.worktreeId)).toBe(1)
  const tab = useAppStore.getState().tabsByWorktree[record.worktreeId][0]
  expect(resumeSleepingAgentSessionsForWorktree(record.worktreeId)).toBe(0)
  expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toEqual(record)
  return { tab, record }
}

describe('automatic resume host admission settlement with empty renderer fence hint', () => {
  it.each(['native-refusal', 'remote:host@@refusal'])(
    'rolls back %s without consuming the source',
    async (id) => {
      const { tab, record } = queueResume()
      const transport = { getPtyId: () => null }
      const session = {
        transport,
        pane: { id: 1 },
        transportStreamGeneration: 1,
        authoritativeReattachGeneration: 0,
        deps: {
          tabId: tab.id,
          worktreeId: record.worktreeId,
          paneTransportsRef: { current: new Map([[1, transport]]) }
        },
        handleReattachResult: vi.fn()
      }
      bindHandleReattachResult(session as never)
      expect(await session.handleReattachResult({ id, reattachUnverifiable: true })).toBe(false)
      const state = useAppStore.getState()
      expect(state.tabsByWorktree[record.worktreeId]).toEqual([])
      expect(state.automaticAgentResumeClaimsByTabId[tab.id]).toBeUndefined()
      expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toEqual(record)
      const persisted = buildWorkspaceSessionPayload(state)
      expect(persisted.tabsByWorktree[record.worktreeId]).toEqual([])
      expect(persisted.sleepingAgentSessionsByPaneKey?.[record.paneKey]).toEqual(record)
    }
  )

  it('consumes the source only after a successful spawn', () => {
    const { tab, record } = queueResume()
    expect(settleAutomaticResumeSpawn(tab.id, true)).toBe(true)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
    expect(useAppStore.getState().tabsByWorktree[record.worktreeId]).toHaveLength(1)
    expect(useAppStore.getState().automaticAgentResumeClaimsByTabId[tab.id]).toBeUndefined()
    useAppStore.setState({ sleepingAgentSessionsByPaneKey: { [record.paneKey]: record } })
    expect(resumeSleepingAgentSessionsForWorktree(record.worktreeId)).toBe(0)
    expect(resumeSleepingAgentSessionsForWorktree(record.worktreeId)).toBe(0)
  })
  it.each(['accepted', 'preconnect'])(
    'a refusal after %s input preserves the new tab',
    async (input) => {
      const { tab, record } = queueResume()
      const transport = { getPtyId: () => null }
      const session = {
        rejectObsoleteDirectSshReattach: () => false,
        terminalRecoveryInstance: { id: 1 },
        transport,
        pane: { id: 1 },
        lastTerminalInputAt: input === 'accepted' ? performance.now() : Number.NEGATIVE_INFINITY,
        transportStreamGeneration: 1,
        authoritativeReattachGeneration: 0,
        deps: {
          tabId: tab.id,
          worktreeId: record.worktreeId,
          preconnectInput: input === 'preconnect' ? 'user typed a new request' : undefined,
          paneTransportsRef: { current: new Map([[1, transport]]) }
        },
        handleReattachResult: vi.fn()
      }
      bindHandleReattachResult(session as never)
      await session.handleReattachResult({ id: '', reattachUnverifiable: true })
      expect(useAppStore.getState().automaticAgentResumeClaimsByTabId[tab.id]).toBeUndefined()
      expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toEqual(record)
      expect(
        useAppStore.getState().tabsByWorktree[record.worktreeId].some((t) => t.id === tab.id)
      ).toBe(true)
    }
  )
  it('review: later refusal cannot close an already admitted live tab', async () => {
    const { tab, record } = queueResume()
    settleAutomaticResumeSpawn(tab.id, true)
    useAppStore.getState().updateTabPtyId(tab.id, 'admitted-live-pty')
    const transport = { getPtyId: () => 'admitted-live-pty' }
    const session = {
      rejectObsoleteDirectSshReattach: () => false,
      terminalRecoveryInstance: { id: 1 },
      transport,
      pane: { id: 1 },
      lastTerminalInputAt: Number.NEGATIVE_INFINITY,
      transportStreamGeneration: 2,
      authoritativeReattachGeneration: 0,
      deps: {
        tabId: tab.id,
        worktreeId: record.worktreeId,
        paneTransportsRef: { current: new Map([[1, transport]]) }
      },
      handleReattachResult: vi.fn()
    }
    bindHandleReattachResult(session as never)
    await session.handleReattachResult({ id: 'admitted-live-pty', reattachUnverifiable: true })
    expect(
      useAppStore.getState().tabsByWorktree[record.worktreeId].some((t) => t.id === tab.id)
    ).toBe(true)
  })

  it('review: successful settlement preserves other identities and workspaces', () => {
    const { tab, record } = queueResume()
    const unrelated = {
      ...record,
      paneKey: 'other:22222222-2222-4222-8222-222222222222',
      tabId: 'other',
      providerSession: { key: 'session_id' as const, id: 'different' }
    }
    const sibling = {
      ...record,
      paneKey: 'sibling:33333333-3333-4333-8333-333333333333',
      tabId: 'sibling',
      worktreeId: 'other-folder'
    }
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [record.paneKey]: record,
        [unrelated.paneKey]: unrelated,
        [sibling.paneKey]: sibling
      }
    })
    settleAutomaticResumeSpawn(tab.id, true)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[unrelated.paneKey]).toEqual(
      unrelated
    )
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[sibling.paneKey]).toEqual(sibling)
  })
})

it('review: admitted bound tab deduplicates after startup is consumed and source rehydrates', () => {
  const { tab, record } = queueResume()
  settleAutomaticResumeSpawn(tab.id, true)
  useAppStore.getState().updateTabPtyId(tab.id, 'admitted-pty')
  useAppStore.getState().setTabLayout(tab.id, {
    root: { type: 'leaf', leafId: '99999999-9999-4999-8999-999999999999' },
    activeLeafId: '99999999-9999-4999-8999-999999999999',
    expandedLeafId: null,
    ptyIdsByLeafId: { '99999999-9999-4999-8999-999999999999': 'admitted-pty' }
  })
  useAppStore.getState().consumeTabStartupCommand(tab.id)
  useAppStore.getState().hydrateWorkspaceSession(
    {
      ...buildWorkspaceSessionPayload(useAppStore.getState()),
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    },
    { additionalValidWorkspaceKeys: [record.worktreeId as never] }
  )
  const count = resumeSleepingAgentSessionsForWorktree(record.worktreeId)
  expect(count).toBe(0)
})

it('skips a protected record even when the separately fetched hint is empty', () => {
  const { record } = queueResume()
  useAppStore.setState({
    tabsByWorktree: { [record.worktreeId]: [] },
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    sleepingAgentSessionsByPaneKey: {
      [record.paneKey]: { ...record, automaticResumeBlockedBy: 'legacy-orchestration-worker' }
    },
    legacyWorkerResumeFencesByPaneKey: {}
  })
  expect(resumeSleepingAgentSessionsForWorktree(record.worktreeId)).toBe(0)
  expect(useAppStore.getState().tabsByWorktree[record.worktreeId]).toEqual([])
})
