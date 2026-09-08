let generation = 0
export function markLegacyWorkerResumeFencesHydrated(): void {
  generation++
}

export async function refreshLegacyWorkerResumeFences(): Promise<void> {
  const requestGeneration = ++generation
  try {
    const fences = await window.api.app.getLegacyWorkerResumeFences()
    const { useAppStore } = await import('@/store')
    if (requestGeneration !== generation) {
      return
    }
    useAppStore.setState({ legacyWorkerResumeFencesByPaneKey: fences })
  } catch (error) {
    console.warn('[orchestration] failed to read legacy worker resume fences', error)
  }
}
