import { readWorkspaceSessionResumeFences } from '../../../shared/workspace-session-resume-fences'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parsePaneKey, parseLegacyNumericPaneKey } from '../../../shared/stable-pane-id'
import type { TerminalStoreGet, TerminalStoreSet } from '../store/terminals/terminal-state'

const pending: (() => void)[] = []
let reading = false
const appliedSessions = new WeakMap<TerminalStoreGet, WeakSet<WorkspaceSessionState>>()

function drainApplications(): void {
  reading = false
  while (!reading && pending.length > 0) {
    pending.shift()!()
  }
}

// Reads and synchronous hydration share this lane, including the read before startup's catalog wait.
export function readAndApplyRuntimeSession<T>(
  read: () => Promise<T>,
  apply: (value: T) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = (): void => {
      reading = true
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
      pending.push(start)
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
  const inScope = (key: string): boolean => {
    const tabId = parsePaneKey(key)?.tabId ?? parseLegacyNumericPaneKey(key)?.tabId
    return tabId !== undefined && targetTabIds!.has(tabId)
  }
  set({
    legacyWorkerResumeFencesByPaneKey: targetTabIds
      ? {
          ...Object.fromEntries(Object.entries(current).filter(([key]) => !inScope(key))),
          ...Object.fromEntries(Object.entries(fences).filter(([key]) => inScope(key)))
        }
      : fences
  })
}

export function hydrateRuntimeSessionFields(
  session: WorkspaceSessionState,
  set: TerminalStoreSet,
  get: TerminalStoreGet,
  targetTabIds?: ReadonlySet<string>
): void {
  if (appliedSessions.get(get)?.has(session)) {
    return
  }
  const apply = (): void => applyReadRuntimeSession(session, set, get, targetTabIds)
  if (reading) {
    pending.push(apply)
  } else {
    apply()
  }
}
