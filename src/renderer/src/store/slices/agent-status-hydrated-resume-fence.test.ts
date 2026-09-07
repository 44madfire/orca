import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

const NOW = 1_800_000_000_000
const PANE_KEY = 'tab-1:11111111-2222-4333-8444-555555555555'

function fencedRecord(
  origin: SleepingAgentSessionRecord['origin'],
  sessionId = 'session-1'
): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: sessionId },
    prompt: '',
    state: 'done',
    capturedAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
    origin,
    automaticResumeBlockedBy: 'legacy-orchestration-worker'
  }
}

function hydrate(record: SleepingAgentSessionRecord, blockedPaneKeys?: Record<string, true>) {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] },
    sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record },
    ...(blockedPaneKeys ? { automaticResumeBlockedPaneKeys: blockedPaneKeys } : {})
  } as Partial<AppState>)
  return store
}

function writeStatus(
  store: ReturnType<typeof createTestStore>,
  status: { state: AgentStatusEntry['state']; prompt: string },
  sessionId = 'session-1'
): void {
  store
    .getState()
    .setAgentStatus(
      PANE_KEY,
      { ...status, agentType: 'claude' } as never,
      undefined,
      { updatedAt: NOW },
      { tabId: 'tab-1', worktreeId: 'wt-1' } as never,
      { providerSession: { key: 'session_id', id: sessionId } }
    )
}

const fenceOf = (store: ReturnType<typeof createTestStore>): string | undefined =>
  store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.automaticResumeBlockedBy

// The fence's durable home is the record. `automaticResumeBlockedPaneKeys` starts empty on every
// renderer boot and is not persisted, so deriving the rebuilt record's flag from that map alone
// erased a hydrated fence on the first status write — and worktree activation then relaunched the
// settled worker with `--resume` over its still-live PTY.
describe('a hydrated resume fence and the volatile blocked-pane map', () => {
  it('is not restored into the blocked-pane map by hydration alone', () => {
    expect(
      hydrate(fencedRecord('worktree-sleep')).getState().automaticResumeBlockedPaneKeys
    ).toEqual({})
  })

  it('survives a status write with the blocked-pane map empty', () => {
    const store = hydrate(fencedRecord('worktree-sleep'))

    writeStatus(store, { state: 'done', prompt: 'worker task' })

    expect(fenceOf(store)).toBe('legacy-orchestration-worker')
  })

  it('survives a live-origin record being rebuilt when the pane state changes', () => {
    const store = hydrate(fencedRecord('live'))

    writeStatus(store, { state: 'working', prompt: 'user takes over' })

    expect(fenceOf(store)).toBe('legacy-orchestration-worker')
  })

  it('survives a manual worktree sleep that recaptures the pane', () => {
    const store = hydrate(fencedRecord('live'))

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1', [PANE_KEY])

    expect(fenceOf(store)).toBe('legacy-orchestration-worker')
  })

  // Control: the pre-existing population, where the fence arrived while the tab was still open.
  it('survives when only the blocked-pane map holds it', () => {
    const store = hydrate(
      { ...fencedRecord('worktree-sleep'), automaticResumeBlockedBy: undefined },
      { [PANE_KEY]: true }
    )

    writeStatus(store, { state: 'done', prompt: 'worker task' })

    expect(fenceOf(store)).toBe('legacy-orchestration-worker')
  })

  // A new provider session in the pane is new work, not the fenced dispatch's work.
  it('is not carried onto a record for a different provider session', () => {
    const store = hydrate(fencedRecord('live'))

    writeStatus(store, { state: 'working', prompt: 'a fresh session' }, 'session-2')

    expect(fenceOf(store)).toBeUndefined()
  })

  it('is dropped from both homes when the runtime lifts it', () => {
    const store = hydrate(fencedRecord('worktree-sleep'), { [PANE_KEY]: true })

    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, false)
    writeStatus(store, { state: 'done', prompt: 'worker task' })

    expect(fenceOf(store)).toBeUndefined()
    expect(store.getState().automaticResumeBlockedPaneKeys).toEqual({})
  })
})
