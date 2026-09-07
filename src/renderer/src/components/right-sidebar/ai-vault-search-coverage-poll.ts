import { useEffect, useSyncExternalStore } from 'react'
import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import { searchCoverageStore } from './ai-vault-search-coverage-store'
export { AI_VAULT_SEARCH_COVERAGE_POLL_MS } from './ai-vault-search-coverage-store'

const subscribeDisabled = (): (() => void) => () => {}

export function useSearchIndexing(enabled: boolean, ownerKey = '') {
  const store = searchCoverageStore(ownerKey)
  const snapshot = useSyncExternalStore(
    enabled ? store.subscribe : subscribeDisabled,
    store.getSnapshot
  )
  return {
    ...snapshot,
    coverage: enabled ? snapshot.coverage : null,
    control: store.control,
    refresh: store.refresh
  }
}

export function useAiVaultSearchCoveragePoll(
  enabled: boolean,
  latest: AiVaultSearchCoverage | null = null,
  ownerKey = ''
): AiVaultSearchCoverage | null {
  const { coverage, refresh } = useSearchIndexing(enabled, ownerKey)
  useEffect(() => {
    if (enabled && latest) {
      void refresh()
    }
  }, [enabled, latest, refresh])
  return enabled ? (coverage ?? latest) : null
}
