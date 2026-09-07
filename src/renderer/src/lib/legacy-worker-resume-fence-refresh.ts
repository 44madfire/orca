import { readAndApplyRuntimeSession, applyReadRuntimeSession } from './runtime-session-application'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { useAppStore } from '@/store'

let inFlight: Promise<void> | null = null
let repeat = false

// Coalesce invalidations; their reads use the same application lane as ordinary hydration.
export async function refreshLegacyWorkerResumeFences(): Promise<void> {
  if (inFlight) {
    repeat = true
    return inFlight
  }
  inFlight = (async () => {
    try {
      do {
        repeat = false
        await readAndApplyRuntimeSession(
          () => window.api.app.getLegacyWorkerResumeFences(),
          (fences) =>
            applyReadRuntimeSession(
              { ...getDefaultWorkspaceSession(), legacyWorkerResumeFencesByPaneKey: fences },
              useAppStore.setState,
              useAppStore.getState
            )
        )
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
