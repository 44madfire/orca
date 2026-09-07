import type { WorkspaceSessionState } from './workspace-session-state-types'

export function readWorkspaceSessionResumeFences(
  session: Pick<
    WorkspaceSessionState,
    'legacyWorkerResumeFencesByPaneKey' | 'sleepingAgentSessionsByPaneKey'
  >
): Record<string, true> {
  return (
    session.legacyWorkerResumeFencesByPaneKey ??
    Object.fromEntries(
      Object.entries(session.sleepingAgentSessionsByPaneKey ?? {})
        .filter(([, record]) => record.automaticResumeBlockedBy === 'legacy-orchestration-worker')
        .map(([key]) => [key, true as const])
    )
  )
}
