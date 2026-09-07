/**
 * Ownership and remount for PTYs whose bytes have been parked, un-ACKed, across the watchdog's
 * stall streak. Wired into the watchdog as a dep by `pty-dispatcher.ts` rather than imported
 * by it: the watchdog is on the freeze-report path and must stay clear of the app store.
 */
import { useAppStore } from '@/store'
import {
  captureTerminalPaneRecoveryGeneration,
  hasPendingTerminalPaneRecovery,
  requestTerminalPaneRecovery
} from './terminal-pane-recovery'

/** Remount the tabs owning `ptyIds` and return the ids whose debt a remount will actually
 *  repay. The rest belong to the write-off lane.
 *
 *  Why the recovery's own verdict decides this, not the store: "some tab lists this id" is a
 *  store fact, while whether a remount can happen is a runtime one — the tab may have left
 *  `tabsByWorktree`, or sit in chat view, which refuses unconditionally. Reporting the store
 *  fact as ownership excluded such ids from BOTH heal lanes on every tick, so their held ACK
 *  had no payer at all and main kept a healthy shell paused. A retry still queued counts as
 *  owned: its bytes are about to be drained, not lost.
 *
 *  No liveness probe, and none is needed: this infers nothing about whether the PTY is alive.
 *  The stall predicate is "held debt has not shrunk", which is evidence about the past — the
 *  bytes arrived over a live path — not a claim about the present. The action is a
 *  renderer-local remount that preserves the PTY either way, so nothing here reads silence as
 *  death, which is what keeps it honest across the SSH execution boundary. The recovery
 *  budget/cooldown is the anti-churn control. */
export async function recoverParkedPanes(ptyIds: string[]): Promise<string[]> {
  // Bounded: this scan runs only for ids stalled across two ticks, never per render.
  const ptyIdsByTabId = useAppStore.getState().ptyIdsByTabId ?? {}
  const owned: string[] = []
  for (const ptyId of ptyIds) {
    const tabId = Object.keys(ptyIdsByTabId).find((candidate) =>
      ptyIdsByTabId[candidate]?.includes(ptyId)
    )
    if (tabId === undefined) {
      continue
    }
    const remounted = await requestTerminalPaneRecovery({
      tabId,
      ptyId,
      reason: 'delivery-parked',
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration(tabId)
    })
    if (remounted || hasPendingTerminalPaneRecovery(tabId)) {
      owned.push(ptyId)
    }
  }
  return owned
}
