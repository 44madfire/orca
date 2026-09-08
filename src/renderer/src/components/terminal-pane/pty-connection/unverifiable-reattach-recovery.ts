import { mayStartFreshPaneSession } from './fresh-spawn-eligibility'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Retire only when this transition is allowed to replace the local session.
export function mayRetireBindingAfterFailedReattach(session: ConnectPanePtySession): boolean {
  return !session.connectionId && !session.runtimeEnvironmentId && mayStartFreshPaneSession(session)
}

export function recoverUnverifiableReattach(
  session: ConnectPanePtySession,
  ptyId: string | null | undefined
): void {
  if (session.directSshRetryAttempt) {
    session.settleDirectSshPaneRetryAttempt(session.directSshRetryAttempt, 'failed')
    return
  }
  void requestTerminalPaneRecovery({
    tabId: session.deps.tabId,
    ptyId: ptyId ?? null,
    reason: 'reattach-unverifiable',
    terminalRecoveryGeneration: session.terminalRecoveryGeneration,
    terminalRecoveryInstanceId: session.terminalRecoveryInstance.id
  })
}
