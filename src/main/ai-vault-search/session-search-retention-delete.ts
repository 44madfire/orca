import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type SyncDatabase from '../sqlite/sync-database'
import { inSessionParseFileLane } from '../ai-vault/session-parse-file-lane'
import { bumpIndexGeneration } from './session-search-index-generation'

export const RETENTION_DELETE_ROWS_PER_STEP = 256

/** A durable tombstone hides partial deletes and lets a reopened store finish them. */
export async function deleteExpiredSearchFiles(
  db: SyncDatabase,
  cutoffMs: number | null,
  closed: () => boolean,
  changed: () => void,
  yieldStep: () => Promise<void> = yieldToEventLoop
): Promise<void> {
  const pending = db.prepare('SELECT path FROM search_pending_deletes').all() as { path: string }[]
  const expired =
    cutoffMs === null
      ? []
      : (db
          .prepare('SELECT path FROM files WHERE mtime_ms < ? ORDER BY mtime_ms')
          .all(cutoffMs) as { path: string }[])
  for (const { path } of [...pending, ...expired]) {
    if (closed()) {
      return
    }
    await inSessionParseFileLane(path, async () => {
      if (closed()) {
        return
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        const file = db
          .prepare(`SELECT session_row_id FROM files WHERE path = ? AND mtime_ms < ?
             AND path NOT IN (SELECT path FROM search_pending_deletes)`)
          .get(path, cutoffMs ?? -Infinity) as { session_row_id: number | null } | undefined
        if (file) {
          if (file.session_row_id !== null) {
            db.prepare(
              'INSERT OR IGNORE INTO search_pending_deletes(path, session_row_id) VALUES (?, ?)'
            ).run(path, file.session_row_id)
            // Tombstoning is the moment the session leaves `visible_sessions`,
            // so it is the moment a reader's answer changes.
            bumpIndexGeneration(db)
          }
          db.prepare('DELETE FROM files WHERE path = ?').run(path)
        }
        db.exec('COMMIT')
        changed()
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      // The loop below deliberately does not move the generation. It is sound
      // only because every read joins a visibility view: these messages keep
      // `batch_id` NULL, so `visible_messages` still lists them, and what makes
      // them unreachable is their session's tombstone in `visible_sessions`,
      // which the transaction above already recorded. Deleting them changes no
      // answer. `session-search-visible-read-ratchet.test.ts` is what keeps that
      // true, by failing any FTS read that skips the join. Bumping here instead
      // would refuse every outstanding cursor once per 256 rows.
      while (!closed()) {
        const pending = db
          .prepare('SELECT session_row_id,batch_id FROM search_pending_deletes WHERE path = ?')
          .get(path) as { session_row_id: number; batch_id: number | null } | undefined
        if (!pending) {
          return
        }
        db.exec('BEGIN IMMEDIATE')
        try {
          const ids = db
            .prepare(
              pending.batch_id === null
                ? 'SELECT id FROM messages WHERE session_row_id = ? LIMIT ?'
                : 'SELECT id FROM messages WHERE batch_id = ? LIMIT ?'
            )
            .all(pending.batch_id ?? pending.session_row_id, RETENTION_DELETE_ROWS_PER_STEP) as {
            id: number
          }[]
          const full = db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
          const conversation = db.prepare('DELETE FROM conversation_fts WHERE rowid = ?')
          const message = db.prepare('DELETE FROM messages WHERE id = ?')
          for (const { id } of ids) {
            full.run(id)
            conversation.run(id)
            message.run(id)
          }
          if (ids.length < RETENTION_DELETE_ROWS_PER_STEP) {
            if (pending.batch_id === null) {
              db.prepare('DELETE FROM search_write_batches WHERE session_row_id=?').run(
                pending.session_row_id
              )
              db.prepare('DELETE FROM sessions WHERE id = ?').run(pending.session_row_id)
            } else {
              db.prepare('DELETE FROM search_write_batches WHERE id=?').run(pending.batch_id)
            }
            db.prepare('DELETE FROM search_pending_deletes WHERE path = ?').run(path)
          }
          db.exec('COMMIT')
          changed()
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
        await yieldStep()
      }
    })
  }
}
