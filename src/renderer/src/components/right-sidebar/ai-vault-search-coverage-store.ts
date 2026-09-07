import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'

export const AI_VAULT_SEARCH_COVERAGE_POLL_MS = 4_000

type Snapshot = {
  coverage: AiVaultSearchCoverage | null
  error: boolean
  busy: boolean
  observedAt: number
  unavailable: boolean
}

/** Settings, status bar and search share a single observation per index owner. */
export function createSearchCoverageStore() {
  let snapshot: Snapshot = {
    coverage: null,
    error: false,
    busy: false,
    observedAt: 0,
    unavailable: false
  }
  let generation = 0
  let stop: (() => void) | null = null
  const listeners = new Set<() => void>()
  const publish = (next: Partial<Snapshot>): void => {
    snapshot = { ...snapshot, ...next }
    listeners.forEach((listener) => listener())
  }
  const refresh = async (): Promise<void> => {
    const issued = ++generation
    try {
      const coverage = await window.api.aiVault.searchCoverage()
      if (issued === generation) {
        publish({ coverage, unavailable: false, observedAt: Date.now() })
      }
    } catch {
      if (issued === generation) {
        publish({ coverage: null, unavailable: true })
      }
    }
  }
  return {
    getSnapshot: () => snapshot,
    refresh,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (listeners.size === 1) {
        stop = installWindowVisibilityInterval({
          run: () => void refresh(),
          intervalMs: AI_VAULT_SEARCH_COVERAGE_POLL_MS
        })
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          stop?.()
          stop = null
          generation++
          snapshot = {
            coverage: null,
            error: false,
            busy: false,
            observedAt: 0,
            unavailable: false
          }
        }
      }
    },
    async control(action: () => Promise<void>): Promise<void> {
      if (snapshot.busy) {
        return
      }
      publish({ busy: true, error: false })
      try {
        await action()
        await refresh()
      } catch {
        publish({ error: true })
      } finally {
        publish({ busy: false })
      }
    }
  }
}

const stores = new Map<string, ReturnType<typeof createSearchCoverageStore>>()
export function searchCoverageStore(ownerKey: string) {
  let store = stores.get(ownerKey)
  if (!store) {
    store = createSearchCoverageStore()
    stores.set(ownerKey, store)
  }
  return store
}
