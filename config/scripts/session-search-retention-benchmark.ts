import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import SyncDatabase from '../../src/main/sqlite/sync-database'
import { SessionSearchQuery } from '../../src/main/ai-vault-search/session-search-query'
import { openSessionSearchDatabase } from '../../src/main/ai-vault-search/session-search-schema'
import { deleteExpiredSearchFiles } from '../../src/main/ai-vault-search/session-search-retention-delete'

// Bundle with esbuild --bundle --platform=node, then run on the host under test.
const root = await mkdtemp(join(tmpdir(), 'orca-search-retention-bench-'))
try {
  for (const mode of ['whole-file', 'batched', 'batched-pinned-reader']) {
    const path = join(root, `${mode}.sqlite`)
    const db = openSessionSearchDatabase(path)
    let reader: SyncDatabase | null = null
    try {
      const query = new SessionSearchQuery(db)
      db.exec(`INSERT INTO sessions(id,agent,session_id,file_path,title,cwd,cwd_key,resume_command)
        VALUES (1,'claude','1','fixture','synthetic benchmark','/fixture','/fixture','');
        INSERT INTO files(path,byte_offset,mtime_ms,session_row_id) VALUES ('fixture',1,1,1);
        BEGIN;
        WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<60000)
        INSERT INTO messages(id,session_row_id,role) SELECT i,1,'user' FROM n;
        INSERT INTO messages_fts(rowid,user_text) SELECT id,'synthetic benchmark needle ' || id ||
          ' repeated context for a representative coding conversation with commands and paths src/example.ts'
          FROM messages;
        INSERT INTO conversation_fts(rowid,user_text) SELECT rowid,user_text FROM messages_fts;
        COMMIT; PRAGMA wal_checkpoint(TRUNCATE)`)
      assert.equal(query.execute({ query: 'needle' }, null).hits.length, 1)
      if (mode === 'batched-pinned-reader') {
        reader = new SyncDatabase(path, { readonly: true })
        reader.exec('BEGIN')
        reader.prepare('SELECT count(*) FROM messages').get()
      }
      const intervals: number[] = []
      let previous = performance.now()
      const started = previous
      if (mode === 'whole-file') {
        db.exec('BEGIN IMMEDIATE')
        const ids = db.prepare('SELECT id FROM messages WHERE session_row_id=1').all() as {
          id: number
        }[]
        for (const { id } of ids) {
          db.prepare('DELETE FROM messages_fts WHERE rowid=?').run(id)
          db.prepare('DELETE FROM conversation_fts WHERE rowid=?').run(id)
        }
        db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM files; COMMIT')
        intervals.push(performance.now() - previous)
      } else {
        await deleteExpiredSearchFiles(
          db,
          100,
          () => false,
          () => {},
          async () => {
            intervals.push(performance.now() - previous)
            assert.equal(query.execute({ query: 'needle' }, null).hits.length, 0)
            await yieldToEventLoop()
            previous = performance.now()
          }
        )
      }
      const wallMs = performance.now() - started
      assert.equal(
        (db.prepare('SELECT count(*) AS n FROM messages_fts').get() as { n: number }).n,
        0
      )
      assert.equal(
        (db.prepare('SELECT count(*) AS n FROM conversation_fts').get() as { n: number }).n,
        0
      )
      const walBytes = (await stat(`${path}-wal`)).size
      intervals.sort((a, b) => a - b)
      console.log(
        JSON.stringify({
          mode,
          platform: process.platform,
          node: process.version,
          rows: 60000,
          wallMs,
          steps: intervals.length,
          maxStepMs: intervals.at(-1),
          p95StepMs: intervals[Math.floor(intervals.length * 0.95)],
          walBytes
        })
      )
    } finally {
      reader?.close()
      db.close()
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
