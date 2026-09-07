/**
 * Ownership and remount for PTYs whose bytes have been parked, un-ACKed, across the watchdog's
 * stall streak. Wired into the watchdog as a dep by `pty-dispatcher.ts` rather than imported
 * by it: the watchdog is on the freeze-report path and must stay clear of the app store.
 */
import { useAppStore } from '@/store'
import {
  captureTerminalPaneRecoveryGeneration,
  requestTerminalPaneRecovery
} from './terminal-pane-recovery'

/** Remount the tabs owning `ptyIds` and return the ids a tab actually owned. The rest have
 *  nothing to remount and belong to the write-off lane.
 *
 *  No liveness probe: the parked bytes ARE the evidence the PTY is alive — they arrived over
 *  a live path — which is what keeps this honest across the SSH execution boundary, where
 *  silence is never proof of death. The recovery budget/cooldown is the anti-churn control. */
export function recoverParkedPanes(ptyIds: string[]): string[] {
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
    owned.push(ptyId)
    void requestTerminalPaneRecovery({
      tabId,
      ptyId,
      reason: 'delivery-parked',
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration(tabId)
    })
  }
  return owned
}
