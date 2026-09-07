import { readWorkspaceSessionResumeFences } from '../../../shared/workspace-session-resume-fences'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parsePaneKey, parseLegacyNumericPaneKey } from '../../../shared/stable-pane-id'
import type { TerminalStoreGet, TerminalStoreSet } from '../store/terminals/terminal-state'

const pendingReads: (() => void)[] = []
let hydratedDuringRead = new Map<TerminalStoreGet, ReadonlySet<string> | null>()
let reading = false
const appliedSessions = new WeakMap<TerminalStoreGet, WeakSet<WorkspaceSessionState>>()

function drainApplications(): void {
  reading = false
  hydratedDuringRead.clear()
  while (!reading && pendingReads.length > 0) {
    pendingReads.shift()!()
  }
}

// Serialize runtime reads; synchronous hydration supersedes their overlapping snapshot scopes.
export function readAndApplyRuntimeSession<T>(
  read: () => Promise<T>,
  apply: (value: T) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = (): void => {
      reading = true
      hydratedDuringRead = new Map()
      void (async () => read())().then(
        (value) => {
          try {
            apply(value)
            drainApplications()
            resolve(value)
          } catch (error) {
            drainApplications()
            reject(error)
          }
        },
        (error) => {
          drainApplications()
          reject(error)
        }
      )
    }
    if (reading) {
      pendingReads.push(start)
    } else {
      start()
    }
  })
}

export function applyReadRuntimeSession(
  session: WorkspaceSessionState,
  set: TerminalStoreSet,
  get: TerminalStoreGet,
  targetTabIds?: ReadonlySet<string>
): void {
  const fields = runtimeSessionFields(session, get, targetTabIds)
  const superseded = hydratedDuringRead.get(get)
  if (superseded === null) {
    return
  }
  if (superseded) {
    const current = get().legacyWorkerResumeFencesByPaneKey
    fields.legacyWorkerResumeFencesByPaneKey = {
      ...Object.fromEntries(
        Object.entries(fields.legacyWorkerResumeFencesByPaneKey).filter(
          ([key]) => !paneInScope(key, superseded)
        )
      ),
      ...Object.fromEntries(Object.entries(current).filter(([key]) => paneInScope(key, superseded)))
    }
  }
  set(fields)
}

function paneInScope(key: string, tabIds: ReadonlySet<string>): boolean {
  const tabId = parsePaneKey(key)?.tabId ?? parseLegacyNumericPaneKey(key)?.tabId
  return tabId !== undefined && tabIds.has(tabId)
}

function runtimeSessionFields(
  session: WorkspaceSessionState,
  get: TerminalStoreGet,
  targetTabIds?: ReadonlySet<string>
): { legacyWorkerResumeFencesByPaneKey: Record<string, true> } {
  let applied = appliedSessions.get(get)
  if (!applied) {
    applied = new WeakSet()
    appliedSessions.set(get, applied)
  }
  applied.add(session)
  const incoming = session.legacyWorkerResumeFencesByPaneKey
  const current = get().legacyWorkerResumeFencesByPaneKey
  // An unsupported source cannot retire known protection; normalize its legacy records on ingress.
  const fences = incoming ?? {
    ...current,
    ...readWorkspaceSessionResumeFences(session)
  }
  return {
    legacyWorkerResumeFencesByPaneKey: targetTabIds
      ? {
          ...Object.fromEntries(
            Object.entries(current).filter(([key]) => !paneInScope(key, targetTabIds))
          ),
          ...Object.fromEntries(
            Object.entries(fences).filter(([key]) => paneInScope(key, targetTabIds))
          )
        }
      : fences
  }
}

export function hydrateRuntimeSessionFields(
  session: WorkspaceSessionState,
  get: TerminalStoreGet,
  targetTabIds?: ReadonlySet<string>
): { legacyWorkerResumeFencesByPaneKey: Record<string, true> } {
  if (appliedSessions.get(get)?.has(session)) {
    return { legacyWorkerResumeFencesByPaneKey: get().legacyWorkerResumeFencesByPaneKey }
  }
  if (reading) {
    const previous = hydratedDuringRead.get(get)
    // Track snapshot scopes, never policy values, until the older read settles.
    hydratedDuringRead.set(
      get,
      !targetTabIds || previous === null ? null : new Set([...(previous ?? []), ...targetTabIds])
    )
  }
  return runtimeSessionFields(session, get, targetTabIds)
}
