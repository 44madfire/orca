import { useAppStore } from '@/store'

let inFlight: Promise<void> | null = null
let repeat = false

/**
 * Re-reads the runtime-authored fenced-pane set after main says it changed. A pull rather than a
 * pushed payload: the set is session state the renderer also hydrates, and an event carrying it
 * could land out of order with that hydration.
 *
 * Reads are serialized and coalesced, so the last read is the last write with no version to
 * compare — two overlapping pings cannot leave an older set installed.
 */
export async function refreshLegacyWorkerResumeFences(): Promise<void> {
  if (inFlight) {
    repeat = true
    return inFlight
  }
  inFlight = (async () => {
    try {
      do {
        repeat = false
        const fences = await window.api.app.getLegacyWorkerResumeFences()
        useAppStore.getState().setLegacyWorkerResumeFences(fences ?? {})
      } while (repeat)
    } catch (error) {
      // Losing a refresh leaves the previously read set in place; the next ping or start re-reads.
      console.warn('[orchestration] failed to read legacy worker resume fences', error)
    } finally {
      inFlight = null
      repeat = false
    }
  })()
  return inFlight
}
