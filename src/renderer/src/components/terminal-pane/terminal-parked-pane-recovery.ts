/**
 * Ownership and remount for PTYs whose bytes have been parked across the watchdog's
 * stall streak. Wired into the watchdog as a dep by `pty-dispatcher.ts` rather than imported
 * by it: the watchdog is on the freeze-report path and must stay clear of the app store.
 */
import { useAppStore } from '@/store'
import {
  captureTerminalPaneRecoveryGeneration,
  requestTerminalPaneRecovery
} from './terminal-pane-recovery'

/** Remount owned panes without inferring PTY liveness or changing producer flow control.
 * Recovery's budget/cooldown bounds churn; unowned bytes remain in the bounded buffer. */
export async function recoverParkedPanes(ptyIds: string[]): Promise<void> {
  // Bounded: this scan runs only for ids stalled across two ticks, never per render.
  const ptyIdsByTabId = useAppStore.getState().ptyIdsByTabId ?? {}
  for (const ptyId of ptyIds) {
    const tabId = Object.keys(ptyIdsByTabId).find((candidate) =>
      ptyIdsByTabId[candidate]?.includes(ptyId)
    )
    if (tabId === undefined) {
      continue
    }
    await requestTerminalPaneRecovery({
      tabId,
      ptyId,
      reason: 'delivery-parked',
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration(tabId)
    })
  }
}
