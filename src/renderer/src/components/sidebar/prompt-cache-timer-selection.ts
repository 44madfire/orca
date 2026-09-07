import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

export type PromptCacheCountdownSelection = {
  startedAt: number
  ttlMs: number
}

const oldestTimerByTabCache = new WeakMap<Record<string, number | null>, Map<string, number>>()

function getCacheTimerTabId(key: string): string | null {
  const separator = key.indexOf(':')
  return separator > 0 ? key.slice(0, separator) : null
}

function getOldestTimerByTab(cacheTimerByKey: Record<string, number | null>): Map<string, number> {
  const cached = oldestTimerByTabCache.get(cacheTimerByKey)
  if (cached) {
    return cached
  }
  const oldestByTab = new Map<string, number>()
  for (const [key, startedAt] of Object.entries(cacheTimerByKey)) {
    if (startedAt == null) {
      continue
    }
    const tabId = getCacheTimerTabId(key)
    if (!tabId) {
      continue
    }
    const oldest = oldestByTab.get(tabId)
    if (oldest === undefined || startedAt < oldest) {
      oldestByTab.set(tabId, startedAt)
    }
  }
  // Timer writes replace the record; share its index across cards and unrelated store updates.
  oldestTimerByTabCache.set(cacheTimerByKey, oldestByTab)
  return oldestByTab
}

export function getMostUrgentPromptCacheStartedAt(
  tabs: readonly Pick<TerminalTab, 'id'>[] | undefined,
  cacheTimerByKey: Record<string, number | null>
): number | null {
  if (!tabs || tabs.length === 0) {
    return null
  }
  const oldestByTab = getOldestTimerByTab(cacheTimerByKey)
  let oldest: number | null = null
  for (const tab of tabs) {
    const startedAt = oldestByTab.get(tab.id)
    if (startedAt !== undefined && (oldest === null || startedAt < oldest)) {
      oldest = startedAt
    }
  }
  return oldest
}

export function getPromptCacheCountdownForPane(
  paneKey: string,
  cacheTimerByKey: Record<string, number | null>,
  ttlMs: number
): PromptCacheCountdownSelection | null {
  if (ttlMs <= 0 || parsePaneKey(paneKey) === null) {
    return null
  }
  const startedAt = cacheTimerByKey[paneKey]
  return startedAt == null ? null : { startedAt, ttlMs }
}
