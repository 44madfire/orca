import { describe, expect, it } from 'vitest'
import { isPaneAutomaticResumeBlocked } from './terminal-pane-resume-fence'
import type { WorkspaceSessionState } from './workspace-session-state-types'

const paneKey = 'worker:11111111-1111-4111-8111-111111111111'
const worktreeId = 'folder-worker'
const session = {
  tabsByWorktree: { [worktreeId]: [{ id: 'worker', worktreeId }] },
  legacyWorkerResumeFencesByPaneKey: { [paneKey]: true },
  sleepingAgentSessionsByPaneKey: {}
} as unknown as WorkspaceSessionState

describe('canonical stable pane resume fence', () => {
  it('blocks a recordless fenced pane only in its workspace', () => {
    expect(isPaneAutomaticResumeBlocked(session, paneKey, worktreeId)).toBe(true)
    expect(isPaneAutomaticResumeBlocked(session, paneKey, 'other-folder')).toBe(false)
  })
  it('an explicit canonical retirement overrides a legacy flag', () => {
    const retired = {
      ...session,
      legacyWorkerResumeFencesByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: { worktreeId, automaticResumeBlockedBy: 'legacy-orchestration-worker' }
      }
    } as unknown as WorkspaceSessionState
    expect(isPaneAutomaticResumeBlocked(retired, paneKey, worktreeId)).toBe(false)
    delete retired.legacyWorkerResumeFencesByPaneKey
    expect(isPaneAutomaticResumeBlocked(retired, paneKey, worktreeId)).toBe(true)
  })
})
