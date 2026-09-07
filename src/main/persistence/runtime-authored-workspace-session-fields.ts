import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** Session fields written by the runtime authority and never by a renderer. */
const RUNTIME_AUTHORED_FIELDS = [
  'clientHostedBrowserPagesByWorktree',
  'legacyWorkerResumeFencesByPaneKey'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

/**
 * Keeps runtime-authored session state alive across a renderer's full write.
 *
 * A session write replaces the stored object, and the renderer builds its payload from Zustand --
 * which has no idea the runtime authority sharing this profile also persists the client-hosted
 * pages and settled-worker resume fences it owns. Without this, every ordinary desktop session
 * write erases them, and the loss only shows up a restart later when there is nothing left to
 * rehydrate.
 *
 * Callers do not opt in: the Store applies this inside setLocalWorkspaceSession and
 * setHostWorkspaceSession, so the before-unload stage path inherits it too. Guarding the individual
 * writers instead is what let the quit write -- the most common one there is -- erase the field.
 *
 * A runtime clearing its own rows writes an empty map, not `undefined`, so this can never pin a
 * stale set: only an author that never mentioned the field inherits the previous one.
 */
export function preserveRuntimeAuthoredWorkspaceSessionFields(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  let preserved: WorkspaceSessionState | undefined
  for (const field of RUNTIME_AUTHORED_FIELDS) {
    if (next[field] !== undefined || prior?.[field] === undefined) {
      continue
    }
    preserved ??= { ...next }
    preserved[field] = prior[field] as never
  }
  return preserved ?? next
}
