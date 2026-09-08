import { describe, expect, it, vi } from 'vitest'
import { isStablePaneResumeBlocked } from './stable-pane-resume-fence'

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
