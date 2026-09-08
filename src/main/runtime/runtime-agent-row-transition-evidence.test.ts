import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { RuntimeAgentRowStore } from './runtime-agent-row-store'
import { selectTerminalAgentStatusEvidence } from './runtime-terminal-agent-status-evidence'

const terminal = {
  waitText: '',
  waitBlockedAt: null,
  title: 'Codex waiting for permission',
  titleStatus: 'permission' as const,
  titleStatusIsLive: true,
  titleUpdatedAt: 2_000
}

function hook(): AgentStatusIpcPayload {
  return {
    paneKey: 'pane', terminalHandle: 'term', state: 'working', prompt: '',
    agentType: 'codex', connectionId: null, receivedAt: 3_000, stateStartedAt: 3_000
  }
}

function evidence(row: AgentStatusIpcPayload) {
  const explicit = new RuntimeAgentRowStore().getFreshExplicit({
    handle: 'term', paneKey: 'pane', hookRows: [row]
  })
  return selectTerminalAgentStatusEvidence(terminal, explicit, null)
}

afterEach(() => vi.restoreAllMocks())

describe('explicit transition age at the runtime row boundary', () => {
  it('does not mint a transition from a legacy row with no transition clock', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_000)
    const row = hook()
    Reflect.deleteProperty(row, 'stateStartedAt')
    expect(evidence(row).status).toBe('permission')
  })

  it('keeps a refreshed working state older than the permission observation', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_000)
    expect(evidence({ ...hook(), stateStartedAt: 1_000 }).status).toBe('permission')
  })

  it('does not turn reconnect delivery time into evidence time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_000)
    expect(evidence({ ...hook(), evidenceObservedAt: 1_000 }).status).toBe('permission')
  })

  it('keeps snapshot provenance conservative even without a remembered clock', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_000)
    expect(evidence({
      ...hook(),
      observation: {
        origin: 'osc', authorityId: 'host', incarnation: 1, revision: 3,
        observedAt: 3_000, kind: 'snapshot'
      }
    }).status).toBe('permission')
  })

  it('accepts a genuinely newer explicit transition', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_000)
    expect(evidence(hook())).toMatchObject({ source: 'explicit', status: 'working' })
  })
})
