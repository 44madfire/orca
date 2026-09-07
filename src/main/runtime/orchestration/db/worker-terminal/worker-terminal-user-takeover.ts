import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

type TakeoverCandidate = { id: string; owner_dispatch_id: string; pane_key: string }

const CANDIDATE_COLUMNS = `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources`
// A stopping worker is already relinquishing the pane; a requested release can still be fenced.
const CANDIDATE_PREDICATE = `ownership_state = 'owned'
  AND release_state IN ('not_requested', 'retained', 'requested')
  AND NOT EXISTS (
    SELECT 1 FROM worker_dispatches w
     WHERE w.dispatch_id = owner_dispatch_id AND w.state = 'stopping'
  )`

/** The resources a takeover of `paneKey` would fence. Exact pane first, then reminted leaves. */
function selectTakeoverCandidates(db: OrchestrationDb, paneKey: string): TakeoverCandidate[] {
  const exact = db.db
    .prepare(`${CANDIDATE_COLUMNS} WHERE pane_key = ? AND ${CANDIDATE_PREDICATE}`)
    .all(paneKey) as TakeoverCandidate[]
  if (exact.length > 0) {
    return exact
  }
  const owned = db.db
    .prepare(`${CANDIDATE_COLUMNS} WHERE ${CANDIDATE_PREDICATE} AND pane_key IS NOT NULL`)
    .all() as TakeoverCandidate[]
  return owned.filter((candidate) => isEquivalentPaneKey(candidate.pane_key, paneKey))
}

/**
 * Whether a takeover of this pane would fence anything, answered without the write lock.
 *
 * The byte input lanes ask once per keystroke, and almost every answer is no — the pane owns no
 * worker, or a human already took it over. Reading that from the same predicate the write uses
 * keeps ordinary typing off `BEGIN IMMEDIATE`, and unlike a remembered answer it cannot go stale
 * when the pane's ownership changes mid-session.
 */
export function hasWorkerTerminalUserTakeoverCandidate(
  this: OrchestrationDb,
  paneKey: string
): boolean {
  return selectTakeoverCandidates(this, paneKey).length > 0
}

// Real user input durably relinquishes orchestration ownership.
export function markWorkerTerminalUserOwned(this: OrchestrationDb, paneKey: string): number {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    // Re-read inside the transaction: any probe outside it is only a hint.
    const candidates = selectTakeoverCandidates(this, paneKey)
    const update = this.db.prepare(
      `UPDATE worker_terminal_resources
       SET ownership_state = 'user_owned', release_state = 'retained',
           retained_reason = 'user_takeover', updated_at = datetime('now')
       WHERE id = ? AND ${CANDIDATE_PREDICATE}`
    )
    let changed = 0
    for (const candidate of candidates) {
      const result = Number(update.run(candidate.id).changes)
      if (result > 0) {
        this.db
          .prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?')
          .run(candidate.owner_dispatch_id)
        changed += result
      }
    }
    this.db.exec('COMMIT')
    return changed
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}
