import { readWorkspaceSessionResumeFences } from '../../../shared/workspace-session-resume-fences'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parsePaneKey, parseLegacyNumericPaneKey } from '../../../shared/stable-pane-id'
import type { TerminalStoreGet, TerminalStoreSet } from '../store/terminals/terminal-state'

const pendingReads: (() => void)[] = []
type HydratedAuthority = {
  tabIds: ReadonlySet<string> | null
  paneKeys: ReadonlySet<string>
}
let hydratedDuringRead = new Map<TerminalStoreGet, HydratedAuthority>()
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
  if (superseded?.tabIds === null) {
    return
  }
  if (superseded) {
    const current = get().legacyWorkerResumeFencesByPaneKey
    fields.legacyWorkerResumeFencesByPaneKey = {
      ...Object.fromEntries(
        Object.entries(fields.legacyWorkerResumeFencesByPaneKey).filter(
          ([key]) => !authorityIncludesPane(key, superseded)
        )
      ),
      ...Object.fromEntries(
        Object.entries(current).filter(([key]) => authorityIncludesPane(key, superseded))
      )
    }
  }
  set(fields)
}

function authorityIncludesPane(key: string, authority: HydratedAuthority): boolean {
  return (
    authority.paneKeys.has(key) || authority.tabIds === null || paneInScope(key, authority.tabIds)
  )
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
    const prior = hydratedDuringRead.get(get)
    const previous = prior?.tabIds
    if (session.legacyWorkerResumeFencesByPaneKey !== undefined) {
      hydratedDuringRead.set(get, {
        tabIds:
          !targetTabIds || previous === null
            ? null
            : new Set([...(previous ?? []), ...targetTabIds]),
        paneKeys: prior?.paneKeys ?? new Set()
      })
    } else {
      const protectedKeys = Object.keys(readWorkspaceSessionResumeFences(session)).filter(
        (key) => !targetTabIds || paneInScope(key, targetTabIds)
      )
      // Legacy records supply protection for individual panes, never scope-wide retirement authority.
      if (protectedKeys.length > 0) {
        hydratedDuringRead.set(get, {
          tabIds: previous === undefined ? new Set() : previous,
          paneKeys: new Set([...(prior?.paneKeys ?? []), ...protectedKeys])
        })
      }
    }
  }
  return runtimeSessionFields(session, get, targetTabIds)
}
