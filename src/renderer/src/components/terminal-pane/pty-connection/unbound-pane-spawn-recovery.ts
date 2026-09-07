import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Settle a spawn that resolved without a PTY id, remounting the pane when
 *  nothing else owns its recovery.
 *
 *  Why this is not self-correcting: the pane stays mounted with no transport
 *  binding, so `registerData` never runs. Main keeps pushing pty:data for the
 *  old id and the dispatcher parks it in the pre-handler buffer. The visibility
 *  reconciler skips unbound panes, so nothing else rebinds one. A remount
 *  reattaches over the still-live PTY and drains the buffer.
 *
 *  Parked bytes now hold their delivery credit, so main's flow control does see
 *  the dead pane and pauses the shell instead of flooding it. That makes the
 *  remount reachable from a second detector — the watchdog's parked-stall lane —
 *  but it is not a replacement: it takes two 15s ticks and only fires once bytes
 *  arrive, while this seam settles a data-silent pane immediately.
 *
 *  A direct-SSH lease runs its own retry ledger, so it keeps ownership here and
 *  a second remount never races it. */
export function settleSpawnThatLeftPaneUnbound(session: ConnectPanePtySession): void {
  // Read before settling: the settle clears the lease this branch tests.
  const directSshRetryOwnsRecovery = Boolean(session.directSshRetryAttempt)
  session.settleDirectSshPaneRetryAttempt(session.directSshRetryAttempt, 'failed')
  if (directSshRetryOwnsRecovery) {
    return
  }
  warnTerminalLifecycleAnomaly('fresh spawn left the pane unbound', {
    tabId: session.deps.tabId,
    worktreeId: session.deps.worktreeId,
    leafId: session.deps.restoredLeafId ?? session.pane.leafId,
    paneId: session.pane.id,
    ptyId: null
  })
  void requestTerminalPaneRecovery({
    tabId: session.deps.tabId,
    ptyId: null,
    reason: 'spawn-left-pane-unbound',
    terminalRecoveryGeneration: session.terminalRecoveryGeneration,
    terminalRecoveryInstanceId: session.terminalRecoveryInstance.id
  })
}
