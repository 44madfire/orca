import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchIndexUpdate } from '../ai-vault/session-search-capture'
import { EMPTY_CONTENT_HASH, type SessionContentHash } from './session-search-content-hash'
import { redactSessionSearchText } from './session-search-redaction'
import { sessionSearchPathKey } from './session-search-path-key'

export class SessionSearchFileRecords {
  constructor(private readonly db: SyncDatabase) {}
  contentHash(rowId: number): SessionContentHash {
    const row = this.db
      .prepare('SELECT content_hash, content_hash_count FROM sessions WHERE id = ?')
      .get(rowId) as { content_hash: string | null; content_hash_count: number } | undefined
    return row ? { hash: row.content_hash, count: row.content_hash_count } : EMPTY_CONTENT_HASH
  }

  upsertSession(
    update: SessionSearchIndexUpdate,
    rowId: number | null,
    contentHash: SessionContentHash
  ): number {
    const session = update.session!
    const values = [
      session.agent,
      session.sessionId,
      session.filePath,
      session.codexHome,
      redactSessionSearchText(session.title),
      session.cwd,
      session.cwd ? sessionSearchPathKey(session.cwd, session.filePath) : null,
      session.branch,
      session.createdAt,
      session.updatedAt,
      session.messageCount,
      session.resumeCommand,
      contentHash.hash,
      contentHash.count
    ]
    if (rowId !== null) {
      this.db
        .prepare(
          `UPDATE sessions SET agent = ?, session_id = ?, file_path = ?, codex_home = ?, title = ?,
             cwd = ?, cwd_key = ?, branch = ?, created_at = ?, updated_at = ?, message_count = ?, resume_command = ?,
             content_hash = ?, content_hash_count = ?
           WHERE id = ?`
        )
        .run(...values, rowId)
      return rowId
    }
    const result = this.db
      .prepare(
        `INSERT INTO sessions(agent, session_id, file_path, codex_home, title, cwd, cwd_key, branch,
           created_at, updated_at, message_count, resume_command, content_hash, content_hash_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...values)
    return Number(result.lastInsertRowid)
  }

  upsertFile(update: SessionSearchIndexUpdate, sessionRowId: number | null): void {
    const { file } = update.candidate
    this.db
      .prepare(
        `INSERT INTO files(path, dev, ino, byte_offset, mtime_ms, size_bytes, session_row_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET dev = excluded.dev, ino = excluded.ino,
           byte_offset = excluded.byte_offset, mtime_ms = excluded.mtime_ms,
           size_bytes = excluded.size_bytes, session_row_id = excluded.session_row_id`
      )
      .run(
        file.path,
        file.dev ?? null,
        file.ino ?? null,
        update.byteOffset,
        file.mtimeMs,
        file.sizeBytes ?? null,
        sessionRowId
      )
  }
}
