import { useAppStore } from '@/store'

/**
 * Main owns the settled-worker resume fence; the renderer's `automaticResumeBlockedPaneKeys` map is
 * volatile and starts empty on every renderer boot, reload included. Pulling the fenced-pane set on
 * the startup handshake is what makes a fence survive a reload — a once-per-process push cannot.
 *
 * Additive on purpose: an unreadable recovery plan also yields an empty set, and loss of contact
 * with the plan is never evidence that a pane stopped needing its fence. Retirement arrives through
 * the live lift push and through main sweeping the durable record.
 */
export async function recoverLegacyWorkerTerminalsAndSeedResumeFences(): Promise<void> {
  const snapshot = await window.api.app.recoverLegacyWorkerTerminalsForRendererStartup()
  const setBlocked = useAppStore.getState().setSleepingAgentAutomaticResumeBlocked
  for (const paneKey of snapshot?.blockedPaneKeys ?? []) {
    setBlocked(paneKey, true)
  }
}
