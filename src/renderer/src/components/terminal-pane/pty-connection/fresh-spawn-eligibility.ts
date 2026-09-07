import { useAppStore } from '@/store'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function mayStartFreshPaneSession(session: ConnectPanePtySession): boolean {
  return (
    !session.isLegacyWorkerAutomaticResumeBlocked() &&
    !useAppStore.getState().deleteStateByWorktreeId?.[session.deps.worktreeId]?.isDeleting
  )
}
