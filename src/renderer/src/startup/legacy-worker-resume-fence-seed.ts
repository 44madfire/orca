import { useAppStore } from '@/store'

/**
 * Main owns the settled-worker resume fence; the renderer's `automaticResumeBlockedPaneKeys` map is
 * volatile and starts empty on every renderer boot, reload included. Pulling main's committed fence
 * state on the startup handshake is what makes a fence survive a reload — a once-per-process push
 * cannot. The reply carries main's commit generation, so a live lift that raced past it wins.
 */
export async function recoverLegacyWorkerTerminalsAndSeedResumeFences(): Promise<void> {
  const snapshot = await window.api.app.recoverLegacyWorkerTerminalsForRendererStartup()
  if (snapshot) {
    useAppStore.getState().applyLegacyWorkerResumeFenceSnapshot(snapshot)
  }
}
