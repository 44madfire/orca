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
  })
})
