import { assertSearchWalBudget } from './session-search-wal-budget'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type SyncDatabase from '../sqlite/sync-database'
import type {
  SessionSearchCapturedMessage,
  SessionSearchFileIdentity,
  SessionSearchIndexedFile,
  SessionSearchIndexWrite
} from '../ai-vault/session-search-capture'
import { EMPTY_CONTENT_HASH, foldContentHash } from './session-search-content-hash'
import { SessionSearchFileRecords } from './session-search-file-records'
import { insertSearchMessage, searchMessageRows } from './session-search-message-rows'
import { discardSearchBatch, retireSearchSession } from './session-search-write-recovery'
import { redactSessionSearchText } from './session-search-redaction'
import { sessionSearchPathKey } from './session-search-path-key'
export { chunkMessageText } from './session-search-message-rows'

export const SEARCH_WRITE_ROWS_PER_STEP = 128
export const SEARCH_WRITE_CHARS_PER_STEP = 256 * 1024

type FileRow = {
  dev: number | null
  ino: number | null
  byte_offset: number
  mtime_ms: number
  size_bytes: number | null
  session_row_id: number | null
}

export class SessionSearchIndexWriter {
  private readonly records: SessionSearchFileRecords
  private activePath: string | null = null
  private invalidated = false
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly db: SyncDatabase) {
    this.records = new SessionSearchFileRecords(db)
  }
  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    const row = this.db
      .prepare(
        'SELECT dev, ino, byte_offset, mtime_ms, size_bytes, session_row_id FROM files WHERE path = ?'
      )
      .get(path) as FileRow | undefined
    if (!row) {
      return null
    }
    if (identity && row.dev !== null && row.ino !== null) {
      if (row.dev !== identity.dev || row.ino !== identity.ino) {
        return null
      }
    }
    return { byteOffset: row.byte_offset, mtimeMs: row.mtime_ms, sizeBytes: row.size_bytes }
  }

  updateMetadata(path: string, session: AiVaultSession): void {
    this.db
      .prepare(`UPDATE sessions SET title = ?, cwd = ?, cwd_key = ?, branch = ?
      WHERE id = (SELECT session_row_id FROM files WHERE path = ?)`)
      .run(
        redactSessionSearchText(session.title),
        session.cwd,
        session.cwd ? sessionSearchPathKey(session.cwd, session.filePath) : null,
        session.branch,
        path
      )
  }

  apply(
    update: SessionSearchIndexWrite,
    active: () => boolean = () => true,
    yieldStep: () => Promise<void> = yieldToEventLoop,
    available: () => boolean = active
  ): Promise<boolean> {
    const run = this.pending
      .catch(() => undefined)
      .then(async () => {
        this.activePath = update.candidate.file.path
        this.invalidated = false
        try {
          return await this.stage(update, active, yieldStep, available)
        } finally {
          this.activePath = null
        }
      })
    this.pending = run
    return run
  }

  /** Invalidation hides the generation immediately; cleanup does the expensive deletes later. */
  removeFile(path: string): void {
    if (this.activePath === path) {
      this.invalidated = true
    }
    const existing = this.file(path)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (existing?.session_row_id != null) {
        retireSearchSession(this.db, existing.session_row_id)
      }
      this.db.prepare('DELETE FROM files WHERE path = ?').run(path)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private file(path: string): Pick<FileRow, 'session_row_id' | 'byte_offset'> | undefined {
    return this.db
      .prepare('SELECT session_row_id,byte_offset FROM files WHERE path = ?')
      .get(path) as Pick<FileRow, 'session_row_id' | 'byte_offset'> | undefined
  }

  private async stage(
    update: SessionSearchIndexWrite,
    active: () => boolean,
    yieldStep: () => Promise<void>,
    available: () => boolean
  ): Promise<boolean> {
    if (!active()) {
      return false
    }
    assertSearchWalBudget(this.db)
    const path = update.candidate.file.path
    const existing = this.file(path)
    const append =
      update.mode === 'append' &&
      existing?.session_row_id != null &&
      existing.byte_offset === update.previousByteOffset
    if (update.mode === 'append' && !append) {
      // A stale producer cannot invalidate a newer published cursor.
      return false
    }
    let hash = append ? this.records.contentHash(existing!.session_row_id!) : EMPTY_CONTENT_HASH
    let sessionId: number
    let batchId: number
    this.db.exec('BEGIN IMMEDIATE')
    try {
      sessionId = append
        ? existing!.session_row_id!
        : this.records.createStagingSession(update.candidate)
      batchId = Number(
        this.db
          .prepare('INSERT INTO search_write_batches(session_row_id) VALUES (?)')
          .run(sessionId).lastInsertRowid
      )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const unchanged = (): boolean => {
      const current = this.file(path)
      return (
        !this.invalidated &&
        current?.session_row_id === existing?.session_row_id &&
        current?.byte_offset === existing?.byte_offset
      )
    }
    try {
      async function* capturedRows() {
        for await (const message of update.messages) {
          hash = foldContentHash(hash, [message])
          yield* searchMessageRows([message])
        }
      }
      const rows = capturedRows()
      let next = await rows.next()
      while (!next.done) {
        const batch: SessionSearchCapturedMessage[] = []
        let chars = 0
        while (
          !next.done &&
          batch.length < SEARCH_WRITE_ROWS_PER_STEP &&
          chars < SEARCH_WRITE_CHARS_PER_STEP
        ) {
          batch.push(next.value)
          chars += next.value.text.length
          next = await rows.next()
        }
        if (!active() || !unchanged()) {
          await rows.return(undefined)
          return false
        }
        assertSearchWalBudget(this.db)
        this.db.exec('BEGIN IMMEDIATE')
        try {
          for (const message of batch) {
            insertSearchMessage(this.db, sessionId, batchId, message)
          }
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
        await yieldStep()
      }
      const result = 'result' in update ? await update.result : update
      if (!active() || !unchanged()) {
        return false
      }
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (!result.session) {
          if (existing?.session_row_id != null) {
            retireSearchSession(this.db, existing.session_row_id)
          }
          this.records.upsertFile(update.candidate, result.byteOffset, null)
          this.db.exec('COMMIT')
          return true
        }
        this.records.updateSession(result.session, sessionId, hash)
        if (!append && existing?.session_row_id != null) {
          retireSearchSession(this.db, existing.session_row_id)
        }
        this.db.prepare('UPDATE sessions SET index_ready=1 WHERE id=?').run(sessionId)
        this.db.prepare('UPDATE search_write_batches SET published=1 WHERE id=?').run(batchId)
        this.records.upsertFile(update.candidate, result.byteOffset, sessionId)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      return true
    } finally {
      if (available()) {
        const batch = this.db
          .prepare('SELECT published FROM search_write_batches WHERE id=?')
          .get(batchId) as { published: number } | undefined
        if (batch?.published === 0) {
          discardSearchBatch(this.db, sessionId, batchId, !append)
        }
      }
    }
  }
}
