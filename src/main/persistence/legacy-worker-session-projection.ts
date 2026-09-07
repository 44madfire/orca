import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

// Old readers consume a derived record flag; only the runtime-authored set can retire it.
export function projectLegacyWorkerSession(session: WorkspaceSessionState): WorkspaceSessionState {
  const fences = session.legacyWorkerResumeFencesByPaneKey
  const records = session.sleepingAgentSessionsByPaneKey
  if (fences === undefined || !records) {
    return session
  }
  let projected: typeof records | undefined
  for (const [paneKey, record] of Object.entries(records)) {
    const fenced = fences[paneKey] === true
    if (fenced === (record.automaticResumeBlockedBy === 'legacy-orchestration-worker')) {
      continue
    }
    projected ??= { ...records }
    if (fenced) {
      projected[paneKey] = { ...record, automaticResumeBlockedBy: 'legacy-orchestration-worker' }
    } else {
      const { automaticResumeBlockedBy: _retired, ...unfenced } = record
      projected[paneKey] = unfenced
    }
  }
  return projected ? { ...session, sleepingAgentSessionsByPaneKey: projected } : session
}
