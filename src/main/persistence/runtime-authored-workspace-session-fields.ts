import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** Session fields written by the runtime authority and never by a renderer. */
const RUNTIME_AUTHORED_FIELDS = [
  'clientHostedBrowserPagesByWorktree',
  'legacyWorkerResumeFencesByPaneKey'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

// Renderer replacement writes cannot erase runtime policy or its retained identity.
export function preserveRuntimeAuthoredWorkspaceSessionFields(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  let preserved: WorkspaceSessionState | undefined
  for (const field of RUNTIME_AUTHORED_FIELDS) {
    if (next[field] === undefined && prior?.[field] !== undefined) {
      preserved ??= { ...next }
      preserved[field] = prior[field] as never
    }
  }
  const fences = (preserved ?? next).legacyWorkerResumeFencesByPaneKey
  for (const paneKey of Object.keys(fences ?? {})) {
    const record = prior?.sleepingAgentSessionsByPaneKey?.[paneKey]
    if (record && !next.sleepingAgentSessionsByPaneKey?.[paneKey]) {
      preserved ??= { ...next }
      preserved.sleepingAgentSessionsByPaneKey = {
        ...preserved.sleepingAgentSessionsByPaneKey,
        [paneKey]: record
      }
    }
  }
  return preserved ?? next
}
