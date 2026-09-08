import type { WorkspaceSessionState } from './workspace-session-state-types'
import { parsePaneKey } from './stable-pane-id'
import { readWorkspaceSessionResumeFences } from './workspace-session-resume-fences'

export function isPaneAutomaticResumeBlocked(
  session: WorkspaceSessionState,
  paneKey: string,
  worktreeId: string
): boolean {
  const record = session.sleepingAgentSessionsByPaneKey?.[paneKey]
  const tabId = parsePaneKey(paneKey)?.tabId
  return (
    readWorkspaceSessionResumeFences(session)[paneKey] === true &&
    (record?.worktreeId === worktreeId ||
      (!record && session.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId) === true))
  )
}
