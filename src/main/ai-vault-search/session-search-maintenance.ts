import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type SyncDatabase from '../sqlite/sync-database'
import { assertSearchWalBudget } from './session-search-wal-budget'
import { redactSessionSearchText } from './session-search-redaction'

const COMPACT_PAGES_PER_STEP = 2000
const WARM_ROWS_PER_STEP = 50_000
const SEARCH_LOG_LIMIT = 5000

export class SessionSearchMaintenance {
  private warmed: Promise<void> | null = null
  constructor(
    private readonly db: SyncDatabase,
    private readonly closed: () => boolean,
    private readonly onError: (error: unknown) => void
  ) {}
  async compact(signal?: AbortSignal): Promise<void> {
    try {
      let freed = Number(this.db.pragma('freelist_count', { simple: true }))
      while (!this.closed() && !signal?.aborted && freed > 0) {
        assertSearchWalBudget(this.db)
        this.db.pragma(`incremental_vacuum(${COMPACT_PAGES_PER_STEP})`)
        const remaining = Number(this.db.pragma('freelist_count', { simple: true }))
        // Why: without auto_vacuum the step is a no-op; never spin on it.
        if (remaining >= freed) {
          return
        }
        freed = remaining
        await yieldToEventLoop()
      }
    } catch (error) {
      this.onError(error)
    }
  }

  /**
   * Reads the messages table through in slices so its pages sit in the OS
   * cache before the first query joins against it. Measured on a 4 GB index:
   * the first query after a cold start drops from ~1.3 s to ~0.45 s, and each
   * slice holds the connection for under 50 ms.
   */
  warm(): Promise<void> {
    this.warmed ??= this.readMessagesThrough().catch((error) => this.onError(error))
    return this.warmed
  }

  private async readMessagesThrough(): Promise<void> {
    const max = (
      this.db.prepare('SELECT max(id) AS id FROM messages').get() as { id: number | null }
    ).id
    const touch = this.db.prepare(
      'SELECT count(*) FROM messages WHERE id BETWEEN ? AND ? AND role IS NOT NULL'
    )
    for (let low = 1; max !== null && low <= max; low += WARM_ROWS_PER_STEP) {
      if (this.closed()) {
        return
      }
      touch.get(low, low + WARM_ROWS_PER_STEP - 1)
      await yieldToEventLoop()
    }
  }

  logQuery(query: string, route: string, hits: number, durationMs: number): void {
    try {
      assertSearchWalBudget(this.db)
      this.db
        .prepare(
          'INSERT INTO search_log(ts, query, route, hits, duration_ms) VALUES (?, ?, ?, ?, ?)'
        )
        .run(new Date().toISOString(), redactSessionSearchText(query), route, hits, durationMs)
      this.db
        .prepare(
          `DELETE FROM search_log WHERE id <= (
             SELECT id FROM search_log ORDER BY id DESC LIMIT 1 OFFSET ?)`
        )
        .run(SEARCH_LOG_LIMIT)
    } catch (error) {
      this.onError(error)
    }
  }
}
