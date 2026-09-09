import type SyncDatabase from '../sqlite/sync-database'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { compactSessionSearchIndex } from './session-search-index-compaction'
import type {
  SessionSearchFileIdentity,
  SessionSearchIndexedFile
} from './session-search-file-cursor'
import {
  SessionSearchIndexWriter,
  type SessionSearchStagedWrite
} from './session-search-index-writer'
import { warmSessionSearchPages } from './session-search-page-warmup'
import { deleteExpiredSearchFiles } from './session-search-retention-delete'
import { openSessionSearchDatabase } from './session-search-schema'

// A paused store keeps recording what it declined, so the set needs a ceiling.
// Above it the oldest record goes and the drop is counted, because a re-read set
// that silently forgets is worse than one that says it is incomplete.
export const STALE_PATH_LIMIT = 20_000

/** One row of the index's own file table, joined to the agent that wrote it. */
export type SessionSearchIndexedSource = {
  path: string
  agent: AiVaultAgent | null
  codexHome: string | null
}

export type SessionSearchStoreOptions = {
  /** The WAL backlog a staging write refuses to grow past. Only tests narrow it. */
  walBudgetBytes?: number
}

/**
 * Owns the index database. PR 2 scope: the write half only — the transcript
 * consumer writes through it and nothing reads from it yet. Lifecycle (who
 * indexes, when, and how the re-read set is drained) belongs to the service.
 */
export class SessionSearchStore {
  private readonly db: SyncDatabase
  private readonly writer: SessionSearchIndexWriter
  private closed = false
  private acceptingWrites = true
  private retentionCutoffMs: number | null = null
  private cleanupRequested = false
  private cleanup: Promise<void> | null = null
  private warmed: Promise<void> | null = null
  private lastIndexedAt: string | null = null
  private writeFailures = 0
  private readonly recoveredWriteCount: number
  // Files this index knows it is behind on. Filled by a declined or abandoned
  // read; PR 3's indexer drains it. Nothing here schedules the re-read.
  private readonly stale = new Map<string, SessionFileCandidate>()
  private droppedStalePaths = 0

  constructor(
    path: string,
    private readonly onError: (error: unknown) => void = (error) =>
      console.warn(
        '[ai-vault-search] index write failed:',
        error instanceof Error ? error.name : 'IndexError'
      ),
    options: SessionSearchStoreOptions = {}
  ) {
    this.db = openSessionSearchDatabase(path)
    // Read before anything can write: open-time recovery tombstones every write
    // that outlived its writer, and the first publish after this starts adding
    // tombstones of its own, so the count is only a crash signal right here.
    this.recoveredWriteCount = Number(
      (this.db.prepare('SELECT count(*) AS n FROM search_pending_deletes').get() as { n: number }).n
    )
    this.writer = new SessionSearchIndexWriter(this.db, options.walBudgetBytes)
  }

  /** Unfinished writes this open had to tombstone; PR 3 reports it as crash recovery. */
  get recoveredWrites(): number {
    return this.recoveredWriteCount
  }

  setAcceptingWrites(accept: boolean): void {
    this.acceptingWrites = accept
  }

  /** The oldest transcript mtime worth indexing; PR 3 derives it from the retention setting. */
  setRetentionCutoffMs(cutoffMs: number | null): void {
    this.retentionCutoffMs = cutoffMs
    for (const [path, candidate] of this.stale) {
      // Only retention prunes the re-read set. Pausing is a reason not to write
      // now, never a reason to forget what still has to be read.
      if (!this.withinRetention(candidate)) {
        this.stale.delete(path)
      }
    }
  }

  /** Whether this candidate is new enough to be worth holding rows for at all. */
  private withinRetention(candidate: SessionFileCandidate): boolean {
    return this.retentionCutoffMs === null || candidate.file.mtimeMs >= this.retentionCutoffMs
  }

  /** Whether a write for this candidate may start right now. */
  acceptsCandidate(candidate: SessionFileCandidate): boolean {
    return !this.closed && this.acceptingWrites && this.withinRetention(candidate)
  }

  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    try {
      return this.writer.indexedFile(path, identity)
    } catch (error) {
      this.onError(error)
      return null
    }
  }

  /** Null when this read cannot extend the index, or when the store refuses writes. */
  beginWrite(
    candidate: SessionFileCandidate,
    mode: 'replace' | 'append',
    previousByteOffset: number
  ): SessionSearchStagedWrite | null {
    if (!this.acceptsCandidate(candidate)) {
      return null
    }
    try {
      return this.writer.beginWrite(candidate, mode, previousByteOffset)
    } catch (error) {
      this.reportWriteFailure(error)
      return null
    }
  }

  writePublished(candidate: SessionFileCandidate): void {
    // Why: a list scan queues every file the backfill has not reached yet; once
    // one lands, a later pass must not re-read the whole queue.
    this.stale.delete(candidate.file.path)
    this.lastIndexedAt = new Date().toISOString()
    this.scheduleCleanup()
  }

  reportWriteFailure(error: unknown): void {
    this.writeFailures += 1
    this.onError(error)
  }

  /**
   * Records a file whose content the index is behind on, for a later whole
   * re-read. Recorded while paused too: a pause is exactly the window in which
   * reads are declined, so refusing to remember them would lose every file the
   * pause covered.
   */
  markStale(candidate: SessionFileCandidate): void {
    if (this.closed || !this.withinRetention(candidate)) {
      return
    }
    // Re-inserting moves the path to the end, so the oldest record is the one
    // dropped when a long pause overruns the bound.
    this.stale.delete(candidate.file.path)
    this.stale.set(candidate.file.path, candidate)
    while (this.stale.size > STALE_PATH_LIMIT) {
      const oldest = this.stale.keys().next()
      if (oldest.done) {
        break
      }
      this.stale.delete(oldest.value)
      this.droppedStalePaths += 1
    }
  }

  /**
   * Files the index knew it was behind on and could not keep a record of. A
   * non-zero count means the re-read set is incomplete, so coverage cannot be
   * reported as whole until a full pass runs.
   */
  get droppedPendingFileCount(): number {
    return this.droppedStalePaths
  }

  /**
   * Hands the re-read set to its scheduler and clears it.
   *
   * These paths are behind, not merely dirty: the index declined their last read
   * because it covered a span the index never saw. Re-dispatching a scan is not
   * enough on its own, because the reader picks `append` from the session list's
   * resume point and the consumer will decline again. The caller must pass each
   * path to `requestWholeTranscriptRead` first.
   */
  takeStale(): SessionFileCandidate[] {
    const candidates = [...this.stale.values()]
    this.stale.clear()
    return candidates
  }

  get pendingFileCount(): number {
    return this.stale.size
  }

  /** Whether this path is already recorded here, so a second queue can avoid counting it twice. */
  hasStale(path: string): boolean {
    return this.stale.has(path)
  }

  get lastWriteAt(): string | null {
    return this.lastIndexedAt
  }

  get failures(): number {
    return this.writeFailures
  }

  /** Files the index currently holds, for a status that reports what is there. */
  get indexedFileCount(): number {
    try {
      return Number((this.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n)
    } catch (error) {
      this.onError(error)
      return 0
    }
  }

  /**
   * What this index believes it holds, for a scheduler that has to notice a
   * source that vanished while nothing was running. `paths` narrows it to a
   * lookup; omitting it walks the whole table, which only a full sweep does.
   */
  indexedSources(paths?: readonly string[]): SessionSearchIndexedSource[] {
    const sql = `SELECT f.path AS path, s.agent AS agent, s.codex_home AS codexHome
      FROM files f LEFT JOIN sessions s ON s.id = f.session_row_id`
    try {
      if (!paths) {
        return this.db.prepare(sql).all() as SessionSearchIndexedSource[]
      }
      const one = this.db.prepare(`${sql} WHERE f.path = ?`)
      return paths.flatMap((path) => one.all(path) as SessionSearchIndexedSource[])
    } catch (error) {
      this.onError(error)
      return []
    }
  }

  /**
   * Drops a source's rows. Only a proven deletion may call this: an unreadable
   * source is `unverifiable`, not `missing`, and keeps its rows
   * (docs/reference/ssh-execution-boundary.md).
   */
  removeFile(path: string): void {
    this.stale.delete(path)
    try {
      this.writer.removeFile(path)
      this.scheduleCleanup()
    } catch (error) {
      this.onError(error)
    }
  }

  /** Hides expired sessions immediately, then removes their rows in resumable batches. */
  async purgeOlderThan(cutoffMs: number | null, signal?: AbortSignal): Promise<void> {
    try {
      await deleteExpiredSearchFiles(
        this.db,
        cutoffMs,
        () => this.closed || signal?.aborted === true,
        () => undefined
      )
      if (!this.closed && !signal?.aborted) {
        await compactSessionSearchIndex(this.db, () => this.closed || signal?.aborted === true)
      }
    } catch (error) {
      if (!this.closed) {
        this.onError(error)
      }
    }
  }

  /**
   * Reads the messages table through so its pages are warm before the first
   * query joins against it. Nothing calls this yet: there is no query to warm
   * for, and warming the FTS pages is the query engine's call to make once it
   * knows which of them it touches.
   */
  warm(): Promise<void> {
    this.warmed ??= warmSessionSearchPages(this.db, () => this.closed).catch((error) =>
      this.onError(error)
    )
    return this.warmed
  }

  close(): void {
    this.closed = true
    this.db.close()
  }

  /** Drains tombstones left by a publish or a removal, one file at a time. */
  scheduleCleanup(): void {
    if (this.closed) {
      return
    }
    if (this.cleanup) {
      this.cleanupRequested = true
      return
    }
    this.cleanupRequested = false
    this.cleanup = deleteExpiredSearchFiles(
      this.db,
      null,
      () => this.closed,
      () => undefined
    )
      .catch((error) => {
        if (!this.closed) {
          this.onError(error)
        }
      })
      .finally(() => {
        this.cleanup = null
        if (this.cleanupRequested) {
          this.scheduleCleanup()
        }
      })
  }

  /** Tests only: the cleanup lane is fire-and-forget everywhere else. */
  settled(): Promise<void> {
    return this.cleanup ?? Promise.resolve()
  }
}
