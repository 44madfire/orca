import { useAppStore } from '@/store'
import {
  advanceLegacyWorkerResumeFenceGeneration,
  currentLegacyWorkerResumeFenceGeneration
} from './legacy-worker-resume-fence-generation'

export async function refreshLegacyWorkerResumeFences(): Promise<void> {
  const requestGeneration = advanceLegacyWorkerResumeFenceGeneration()
  try {
    const fences = await window.api.app.getLegacyWorkerResumeFences()
    // A reply older than a later request or hydration describes state that has since been replaced.
    if (requestGeneration !== currentLegacyWorkerResumeFenceGeneration()) {
      return
    }
    useAppStore.setState({ legacyWorkerResumeFencesByPaneKey: fences })
  } catch (error) {
    console.warn('[orchestration] failed to read legacy worker resume fences', error)
  }
}
