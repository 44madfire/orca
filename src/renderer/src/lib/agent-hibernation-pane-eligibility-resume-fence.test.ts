import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { getEligiblePane } from './agent-hibernation-pane-eligibility'

const NOW = 1_800_000_000_000
const LEAF_ID = '11111111-2222-4333-8444-555555555555'
const PANE_KEY = `tab-1:${LEAF_ID}`

const tab = { id: 'tab-1', worktreeId: 'wt-1', title: 't' } as unknown as TerminalTab

const entry: AgentStatusEntry = {
  state: 'done',
  prompt: 'worker task',
  updatedAt: NOW - 600_000,
  stateStartedAt: NOW - 600_000,
  stateHistory: [],
  agentType: 'claude',
  paneKey: PANE_KEY,
  tabId: 'tab-1',
  worktreeId: 'wt-1',
  providerSession: { key: 'session_id', id: 'session-1' }
}

const liveAnchor: SleepingAgentSessionRecord = {
  paneKey: PANE_KEY,
  tabId: 'tab-1',
  worktreeId: 'wt-1',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'session-1' },
  prompt: '',
  state: 'done',
  capturedAt: NOW - 600_000,
  updatedAt: NOW - 600_000,
  origin: 'live'
}

function plan(
  record: SleepingAgentSessionRecord | undefined,
  legacyWorkerResumeFencesByPaneKey: Record<string, true> = {}
) {
  return getEligiblePane({
    entry,
    tab,
    layout: { ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' } } as never,
    livePtyIds: new Set(['pty-1']),
    sleepingAgentSessionsByPaneKey: record ? { [PANE_KEY]: record } : {},
    legacyWorkerResumeFencesByPaneKey,
    lastTerminalInputAtByPaneKey: {},
    foregroundTerminalLastSeenAtByTabId: {},
    ptyBindingFirstSeenAtByPaneKey: {},
    boundaryResolvedAtByPaneKey: {},
    mobileLockedPtyIds: new Set(),
    now: NOW,
    idleMs: 60_000
  })
}

// Hibernating a fenced pane kills a worker PTY that must not be automatically relaunched. The fence
// is runtime-authored session state keyed by pane, so it covers a worker that settled while its tab
// was still open — the case that has no sleeping record for a flag to live on.
describe('hibernation eligibility and the settled-worker resume fence', () => {
  it('blocks the kill for a fenced pane that has a record', () => {
    expect(plan(liveAnchor, { [PANE_KEY]: true })).toBeNull()
  })

  it('blocks the kill for a fenced pane that has no record yet', () => {
    expect(plan(undefined, { [PANE_KEY]: true })).toBeNull()
  })

  // Controls: the ordinary completed-agent population must still hibernate.
  it('admits an unfenced pane holding only its live resume anchor', () => {
    expect(plan(liveAnchor)).not.toBeNull()
  })

  it('admits an unfenced pane with no record at all', () => {
    expect(plan(undefined)).not.toBeNull()
  })

  it('admits a pane when a different pane is the fenced one', () => {
    expect(plan(liveAnchor, { 'tab-9:other-leaf': true })).not.toBeNull()
  })

  // The record flag is an outbound projection for older clients, never an input to a decision.
  it('ignores a record flag the runtime no longer claims', () => {
    const stale = {
      ...liveAnchor,
      automaticResumeBlockedBy: 'legacy-orchestration-worker' as const
    }
    expect(plan(stale)).not.toBeNull()
  })
})
