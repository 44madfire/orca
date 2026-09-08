import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'

export const AI_VAULT_SEARCH_COVERAGE_POLL_MS = 4_000

/** Phases that advance on their own. Every other state changes only when someone acts on it. */
const SELF_ADVANCING_PHASES: ReadonlySet<string> = new Set([
  'idle',
  'discovering',
  'indexing',
  'updating'
])

type Snapshot = {
  coverage: AiVaultSearchCoverage | null
  busy: boolean
  /** A read or a control action did not land; both read the same to the user. */
  failed: boolean
  /** Renderer clock of the newest read, so callers never subtract the host's clock from ours. */
  observedAt: number
  /** Renderer clock of the first read that reported the run now on screen. */
  phaseSince: number
}

/** Identity of one indexing run, so a re-read of the same run does not restart its age. */
function runKey(coverage: AiVaultSearchCoverage | null): string {
  const indexing = coverage?.indexing
  return indexing ? `${indexing.phase}:${indexing.startedAt}` : ''
}

/** Settings, status bar and search share a single observation per index owner. */
export function createSearchCoverageStore() {
  let snapshot: Snapshot = {
    coverage: null,
    busy: false,
    failed: false,
    observedAt: 0,
    phaseSince: 0
  }
  let generation = 0
  let stop: (() => void) | null = null
  let unsubscribeFocus: (() => void) | null = null
  const listeners = new Set<() => void>()

  // Why: an index that reached a resting phase cannot change until the user acts or the app is
  // refocused, so a standing interval would keep a scanner worker resident for nothing.
  const shouldPoll = (): boolean => {
    if (!listeners.size) {
      return false
    }
    const phase = snapshot.coverage?.indexing?.phase
    if (phase) {
      return SELF_ADVANCING_PHASES.has(phase)
    }
    return snapshot.coverage === null && !snapshot.failed
  }

  const syncPolling = (): void => {
    const wanted = shouldPoll()
    if (wanted === (stop !== null)) {
      return
    }
    if (wanted) {
      stop = installWindowVisibilityInterval({
        run: () => void refresh(),
        intervalMs: AI_VAULT_SEARCH_COVERAGE_POLL_MS
      })
      return
    }
    stop?.()
    stop = null
  }

  const publish = (next: Partial<Snapshot>): void => {
    snapshot = { ...snapshot, ...next }
    listeners.forEach((listener) => listener())
    syncPolling()
  }

  const record = (coverage: AiVaultSearchCoverage): void => {
    const observedAt = Date.now()
    const sameRun = runKey(coverage) === runKey(snapshot.coverage)
    publish({
      coverage,
      failed: false,
      observedAt,
      phaseSince: sameRun ? snapshot.phaseSince : observedAt
    })
  }

  let pending: Promise<void> | null = null
  const refresh = (afterControl = false): Promise<void> => {
    if (snapshot.busy && !afterControl) {
      return Promise.resolve()
    }
    if (pending) {
      return pending
    }
    const issued = generation
    const request = (async () => {
      try {
        const coverage = await window.api.aiVault.searchCoverage()
        if (issued === generation) {
          record(coverage)
        }
      } catch {
        if (issued === generation) {
          publish({ coverage: null, failed: true })
        }
      }
    })().finally(() => {
      if (pending === request) {
        pending = null
      }
    })
    pending = request
    return request
  }

  return {
    getSnapshot: () => snapshot,
    refresh: () => refresh(),
    /** Publishes a read the caller already holds; a search result carries the freshest coverage. */
    observe(coverage: AiVaultSearchCoverage): void {
      if (!snapshot.busy) {
        record(coverage)
      }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (listeners.size === 1) {
        unsubscribeFocus = window.api.aiVault.onWindowFocused?.(() => void refresh()) ?? null
      }
      syncPolling()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          unsubscribeFocus?.()
          unsubscribeFocus = null
        }
        syncPolling()
      }
    },
    async control(action: () => Promise<void>): Promise<void> {
      if (snapshot.busy) {
        return
      }
      const controlled = ++generation
      pending = null
      publish({ busy: true, failed: false })
      try {
        await action()
        if (controlled === generation) {
          await refresh(true)
        }
      } catch {
        if (controlled === generation) {
          publish({ failed: true })
        }
      } finally {
        if (controlled === generation) {
          publish({ busy: false })
        }
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
