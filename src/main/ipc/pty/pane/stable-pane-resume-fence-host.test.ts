import { describe, expect, it, vi } from 'vitest'
import { isStablePaneResumeBlocked, isSleepingAgentResumeBlocked } from './stable-pane-resume-fence'

describe('review host-scoped fence', () => {
  it('reads SSH policy when the identical local pane is not fenced', () => {
    const paneKey = 'tab-worker:5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b'
    const worktreeId = 'folder-worker'
    const local = { sleepingAgentSessionsByPaneKey: {} }
    const remote = {
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: { worktreeId, automaticResumeBlockedBy: 'legacy-orchestration-worker' }
      }
    }
    const store = { getWorkspaceSession: vi.fn((host) => (host === 'ssh:host' ? remote : local)) }
    expect(isStablePaneResumeBlocked(store as never, paneKey, worktreeId, 'host')).toBe(true)
  })
})

const leaf = '11111111-1111-4111-8111-111111111111',
  key = `source:${leaf}`,
  wt = 'folder-worker',
  ps = { key: 'session_id' as const, id: 'same' }
function fixture() {
  const session = {
    sleepingAgentSessionsByPaneKey: {
      [key]: { worktreeId: wt, agent: 'claude', providerSession: ps }
    },
    legacyWorkerResumeFencesByPaneKey: { [key]: true },
    tabsByWorktree: { [wt]: [{ id: 'source', worktreeId: wt }] },
    terminalLayoutsByTabId: { source: { ptyIdsByLeafId: { [leaf]: 'pty' } } }
  }
  const store = {
    getWorkspaceSession: vi.fn((host?: string) =>
      host === 'ssh:host'
        ? session
        : { ...session, sleepingAgentSessionsByPaneKey: {}, legacyWorkerResumeFencesByPaneKey: {} }
    )
  }
  return { session, store }
}
it('review: resume identity stays in its workspace, agent and host partition', () => {
  const { store } = fixture()
  const a = {
    worktreeId: wt,
    connectionId: 'host',
    launchAgent: 'claude' as const,
    resumeProviderSession: ps
  }
  expect(isSleepingAgentResumeBlocked(store as never, a)).toBe(true)
  for (const patch of [
    { worktreeId: 'other' },
    { launchAgent: 'codex' },
    { connectionId: null },
    { resumeProviderSession: undefined },
    { resumeProviderSession: { key: 'session_id', id: 'other' } }
  ]) {
    expect(isSleepingAgentResumeBlocked(store as never, { ...a, ...patch } as never)).toBe(false)
  }
})
it('review: a matching fenced duplicate wins regardless of unfenced record order', () => {
  const { session, store } = fixture()
  const record = session.sleepingAgentSessionsByPaneKey[key]
  session.sleepingAgentSessionsByPaneKey = {
    [`other:${leaf}`]: { ...record },
    [key]: record
  } as never
  expect(
    isSleepingAgentResumeBlocked(store as never, {
      worktreeId: wt,
      connectionId: 'host',
      resumeProviderSession: ps
    })
  ).toBe(true)
})
