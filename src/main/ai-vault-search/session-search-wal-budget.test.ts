import { removeTree } from '../../shared/windows-transient-lock-removal'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import * as Wal from './session-search-wal-budget'
import { stagedWriteUpdate } from './session-search-staged-write-fixtures'
import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchStore } from './session-search-store'
import { assertSearchWalBudget, SearchWalBackpressureError } from './session-search-wal-budget'

it('backpressures a pinned snapshot and resumes checkpoints after that reader releases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ss-wal-budget-'))
  const path = join(root, 'index.sqlite')
  const store = new SessionSearchStore(path)
  const reader = new SyncDatabase(path, { readonly: true })
  try {
    assertSearchWalBudget(store.db)
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM sessions').get()
    store.db
      .prepare("INSERT INTO search_log(ts,query,route,hits,duration_ms) VALUES ('t',?,'or',0,0)")
      .run('synthetic'.repeat(10000))
    expect(() => assertSearchWalBudget(store.db, 4096)).toThrow(SearchWalBackpressureError)
    reader.exec('COMMIT')
    expect(() => assertSearchWalBudget(store.db, 4096)).not.toThrow()
  } finally {
    reader.close()
    store.close()
    await removeTree(root)
  }
})

it('retains the old searchable generation and retries a backpressured write after reader release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ss-wal-write-'))
  const path = join(root, 'index.sqlite')
  const errors: unknown[] = []
  const store = new SessionSearchStore(path, (error) => errors.push(error))
  const reader = new SyncDatabase(path, { readonly: true })
  try {
    await store.apply(stagedWriteUpdate('oldneedle', 1))
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM messages').get()
    const actual = Wal.assertSearchWalBudget
    const spy = vi.spyOn(Wal, 'assertSearchWalBudget').mockImplementation((db) => actual(db, 4096))
    await store.apply(stagedWriteUpdate('newneedle', 1000, 'append'))
    expect(errors.some((error) => error instanceof SearchWalBackpressureError)).toBe(true)
    expect(store.staleCount).toBe(1)
    expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
    expect(store.search({ query: 'newneedle' }).hits).toHaveLength(0)
    expect(store.indexedFile('synthetic-transcript', null)?.byteOffset).toBe(1)
    reader.exec('COMMIT')
    spy.mockRestore()
    await store.apply(stagedWriteUpdate('newneedle', 1000, 'append'))
    await store.purgeOlderThan(null)
    expect(store.search({ query: 'newneedle' }).hits).toHaveLength(1)
    expect(store.staleCount).toBe(0)
    expect(store.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1001 })
  } finally {
    vi.restoreAllMocks()
    reader.close()
    store.close()
    await removeTree(root)
  }
})
