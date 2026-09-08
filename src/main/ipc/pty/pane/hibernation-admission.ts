import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Store } from '../../../persistence'
import { resolvePersistedStablePaneOwner } from './stable-owner'
import { isStablePaneResumeBlocked, StablePaneResumeBlockedError } from './stable-pane-resume-fence'

export function assertPtyHibernationAllowed(
  store: Store | undefined,
  ptyId: string,
  connectionId: string | null | undefined
): void {
  const session = store?.getWorkspaceSession?.(
    connectionId ? toSshExecutionHostId(connectionId) : undefined
  )
  for (const tabs of Object.values(session?.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      for (const leafId of Object.keys(
        session?.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId ?? {}
      )) {
        const paneKey = makePaneKey(tab.id, leafId)
        if (
          resolvePersistedStablePaneOwner(store, paneKey, tab.worktreeId, connectionId)?.ptyId ===
            ptyId &&
          isStablePaneResumeBlocked(store, paneKey, tab.worktreeId, connectionId)
        ) {
          throw new StablePaneResumeBlockedError('agent_hibernation_automatic_resume_blocked')
        }
      }
    }
  }
}
