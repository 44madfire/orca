import { withCursorChatMetaScan } from '../ai-vault/session-scanner-cursor-chat-meta'
import { withSessionSearchIndexRequired } from '../ai-vault/session-search-capture'
import {
  createSessionParseStats,
  parseAgentSessionFileCached
} from '../ai-vault/session-scanner-parse-cache'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { SessionSearchStore } from './session-search-store'
import { pauseBackfill } from './session-search-backfill-pacing'

export async function parseSearchCandidates(
  store: SessionSearchStore,
  candidates: SessionFileCandidate[],
  signal?: AbortSignal,
  waitForSearches?: () => Promise<void>
): Promise<void> {
  const stats = createSessionParseStats()
  let sinceYield = 0
  await withCursorChatMetaScan(() =>
    withSessionSearchIndexRequired(async () => {
      for (const candidate of candidates) {
        throwIfAiVaultScanCancelled(signal)
        if (!store.acceptsCandidate(candidate)) {
          continue
        }
        const failures = store.failures
        let failed = false
        try {
          await parseAgentSessionFileCached(candidate, process.platform, stats)
        } catch (error) {
          failed = true
          store.recordParseFailure(candidate.agent)
          console.warn(
            '[ai-vault-search] backfill skipped',
            candidate.agent,
            error instanceof Error ? error.name : 'ParseError'
          )
        }
        if (waitForSearches && !signal?.aborted) {
          store.indexing.processed(failed || store.failures > failures)
          await waitForSearches()
        }
        sinceYield++
        if (sinceYield >= 8) {
          sinceYield = 0
          await pauseBackfill(signal)
        }
      }
    })
  )
}
