import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

/**
 * The single site where `automaticResumeBlockedBy` is stamped onto an outgoing record.
 *
 * The fence itself lives in `legacyWorkerResumeFencesByPaneKey`, which main owns and this renderer
 * never writes. The record flag is a projection kept only so a client too old to read that field
 * still hydrates fenced records as fenced. Projecting here — the one function both the patch path
 * and the full-state path build records through — is what lets every record writer stay unaware of
 * the fence: the flag is derived on the way out rather than carried through the store.
 */
export function buildSleepingAgentSessionData(snapshot: {
  sleepingAgentSessionsByPaneKey?: WorkspaceSessionState['sleepingAgentSessionsByPaneKey']
  legacyWorkerResumeFencesByPaneKey?: Record<string, true>
}): Pick<WorkspaceSessionState, 'sleepingAgentSessionsByPaneKey'> {
  const records = snapshot.sleepingAgentSessionsByPaneKey
  if (!records || Object.keys(records).length === 0) {
    return {}
  }
  const fences = snapshot.legacyWorkerResumeFencesByPaneKey ?? {}
  let projected: WorkspaceSessionState['sleepingAgentSessionsByPaneKey'] | undefined
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
  return { sleepingAgentSessionsByPaneKey: projected ?? records }
}
