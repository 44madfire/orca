import type SyncDatabase from '../sqlite/sync-database'

export function retireSearchSession(
  db: SyncDatabase,
  sessionId: number,
  path = `\0session:${sessionId}`
): void {
  db.prepare('INSERT OR IGNORE INTO search_pending_deletes(path,session_row_id) VALUES (?,?)').run(
    path,
    sessionId
  )
}

export function discardSearchBatch(
  db: SyncDatabase,
  sessionId: number,
  batchId: number,
  ownsSession: boolean
): void {
  if (ownsSession) {
    retireSearchSession(db, sessionId)
  } else {
    db.prepare(
      'INSERT OR IGNORE INTO search_pending_deletes(path,session_row_id,batch_id) VALUES (?,?,?)'
    ).run(`\0batch:${batchId}`, sessionId, batchId)
  }
}

/** Only called on open, before this store can have active writers. */
export function recoverSearchWrites(db: SyncDatabase): void {
  db.exec(`INSERT OR IGNORE INTO search_pending_deletes(path,session_row_id)
    SELECT char(0)||'session:'||id,id FROM sessions WHERE index_ready=0;
    INSERT OR IGNORE INTO search_pending_deletes(path,session_row_id,batch_id)
    SELECT char(0)||'batch:'||b.id,b.session_row_id,b.id FROM search_write_batches b
    JOIN sessions s ON s.id=b.session_row_id WHERE b.published=0 AND s.index_ready=1`)
}
