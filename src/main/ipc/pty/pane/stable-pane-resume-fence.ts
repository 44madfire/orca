import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { isPaneAutomaticResumeBlocked } from '../../../../shared/terminal-pane-resume-fence'
import type { Store } from '../../../persistence'

export function isStablePaneResumeBlocked(
  store: Store | undefined,
  paneKey: string | null | undefined,
  worktreeId: string | undefined,
  connectionId: string | null | undefined
): boolean {
  if (!paneKey || !worktreeId || !store?.getWorkspaceSession) {
    return false
  }
  return isPaneAutomaticResumeBlocked(
    store.getWorkspaceSession(connectionId ? toSshExecutionHostId(connectionId) : undefined),
    paneKey,
    worktreeId
  )
}

export class StablePaneResumeBlockedError extends Error {}
