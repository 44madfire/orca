import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Store } from '../../../persistence'
import { retireTerminalSurfaceFromPersistence } from '../../../runtime/mobile-session-terminal-persistence-retirement'
import { resolvePersistedStablePaneOwner, type StablePaneOwner } from './stable-owner'

export function retirePersistedStablePaneOwner(
  store: Store | undefined,
  owner: StablePaneOwner,
  worktreeId: string,
  connectionId: string | null | undefined
): boolean {
  if (!store) {
    return false
  }
  const paneKey = makePaneKey(owner.tabId, owner.leafId)
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : undefined
  const current = resolvePersistedStablePaneOwner(store, paneKey, worktreeId, connectionId)
  if (!current) {
    // Why: persistence already dropped this pane binding (an earlier stop retired it while the
    // runtime kept history), so there is nothing left to clear — that is a completed retirement,
    // not a competing owner. Reporting failure here strands the pane after its PTY is proven dead.
    return true
  }
  if (current.ptyId !== owner.ptyId || current.incarnationId !== owner.persistedIncarnationId) {
    return false
  }
  const session = store.getWorkspaceSession(hostId)
  const retired = retireTerminalSurfaceFromPersistence(session, {
    worktreeId,
    parentTabId: owner.tabId,
    leafId: owner.leafId,
    ptyId: owner.ptyId,
    ...(current.incarnationId ? { incarnationId: current.incarnationId } : {})
  })
  if (retired === session) {
    return false
  }
  store.setWorkspaceSession(retired, hostId)
  store.flushOrThrow()
  return true
}
