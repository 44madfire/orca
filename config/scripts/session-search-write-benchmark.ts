import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { deleteExpiredSearchFiles } from '../../src/main/ai-vault-search/session-search-retention-delete'
import { SessionSearchIndexWriter } from '../../src/main/ai-vault-search/session-search-index-writer'
import { SessionSearchQuery } from '../../src/main/ai-vault-search/session-search-query'
import { openSessionSearchDatabase } from '../../src/main/ai-vault-search/session-search-schema'
import { stagedWriteUpdate } from '../../src/main/ai-vault-search/session-search-staged-write-test-fixture'

const root = await mkdtemp(join(tmpdir(), 'orca-search-write-bench-'))
try {
  const path = join(root, 'index.sqlite')
  const db = openSessionSearchDatabase(path)
  try {
    const writer = new SessionSearchIndexWriter(db)
    const query = new SessionSearchQuery(db)
    for (const mode of ['replace', 'append', 'replace'] as const) {
      const update = stagedWriteUpdate(
        `benchmarkneedle ${'synthetic coding context src/example.ts '.repeat(5)}`,
        60000,
        mode
      )
      const steps: number[] = []
      let before = performance.now()
      const start = before
      await writer.apply(update, {
        yieldStep: async () => {
          steps.push(performance.now() - before)
          await yieldToEventLoop()
          before = performance.now()
        }
      })
      const wallMs = performance.now() - start
      if (!steps.length) {
        steps.push(wallMs)
      }
      assert.equal(query.execute({ query: 'benchmarkneedle' }, null).hits.length, 1)
      console.log(
        JSON.stringify({
          platform: process.platform,
          node: process.version,
          mode,
          rows: 60000,
          wallMs,
          maxStepMs: Math.max(...steps),
          steps: steps.length,
          walBytes: (await stat(`${path}-wal`)).size
        })
      )
      await deleteExpiredSearchFiles(
        db,
        null,
        () => false,
        () => {}
      )
    }
  } finally {
    db.close()
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
