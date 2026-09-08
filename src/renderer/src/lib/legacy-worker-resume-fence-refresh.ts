import { useAppStore } from '@/store'

export async function refreshLegacyWorkerResumeFences(): Promise<void> {
  try {
    const fences = await window.api.app.getLegacyWorkerResumeFences()
    useAppStore.setState({ legacyWorkerResumeFencesByPaneKey: fences })
  } catch (error) {
    console.warn('[orchestration] failed to read legacy worker resume fences', error)
  }
}
