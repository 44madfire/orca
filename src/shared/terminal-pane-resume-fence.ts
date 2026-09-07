import type { WorkspaceSessionState } from './workspace-session-state-types'

export function isPaneAutomaticResumeBlocked(
  session: WorkspaceSessionState,
  paneKey: string,
  worktreeId: string
): boolean {
  const record = session.sleepingAgentSessionsByPaneKey?.[paneKey]
  return (
    record?.worktreeId === worktreeId &&
    record.automaticResumeBlockedBy === 'legacy-orchestration-worker'
  )
}
