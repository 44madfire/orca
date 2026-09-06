import { removeTree } from '../../shared/windows-transient-lock-removal'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { SessionSearchStore } from './session-search-store'
import { SessionSearchIndexWriter, SEARCH_WRITE_ROWS_PER_STEP } from './session-search-index-writer'
import { stagedWriteUpdate as update } from './session-search-staged-write-fixtures'

it.each(['replace', 'append'] as const)(
  'publishes a large %s atomically after bounded steps',
  async (mode) => {
    const store = new SessionSearchStore(':memory:')
    const writer = new SessionSearchIndexWriter(store.db)
    try {
      await writer.apply(update('oldneedle', 1))
      let steps = 0,
        previous = 0
      const applied = await writer.apply(
        update('newneedle', 1000, mode),
        () => true,
        async () => {
          const rows = (
            store.db
              .prepare(
                'SELECT count(*) AS n FROM messages WHERE batch_id IN (SELECT id FROM search_write_batches WHERE published=0)'
              )
              .get() as { n: number }
          ).n
          expect(rows - previous).toBeLessThanOrEqual(SEARCH_WRITE_ROWS_PER_STEP)
          previous = rows
          steps++
          expect(store.search({ query: 'newneedle' }).hits).toHaveLength(0)
          expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
          expect(writer.indexedFile('synthetic-transcript', null)?.byteOffset).toBe(1)
        }
      )
      expect(applied).toBe(true)
      expect(steps).toBe(8)
      expect(store.search({ query: 'newneedle' }).hits).toHaveLength(1)
      expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(mode === 'append' ? 1 : 0)
      expect(store.search({ query: 'newneedle' }).hits[0].title).toBe('newneedle')
      await store.purgeOlderThan(null)
      expect(
        (store.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n
      ).toBe(mode === 'append' ? 1001 : 1000)
    } finally {
      store.close()
    }
  }
)

it.each(['replace', 'append'] as const)(
  'recovers an interrupted %s without publishing rows or advancing its cursor',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'ss-staged-'))
    const path = join(root, 'index.sqlite')
    let store = new SessionSearchStore(path),
      open = true
    try {
      const writer = new SessionSearchIndexWriter(store.db)
      await writer.apply(update('oldneedle', 1))
      expect(
        await writer.apply(
          update('newneedle', 1000, mode),
          () => open,
          async () => {
            store.close()
            open = false
          }
        )
      ).toBe(false)
      store = new SessionSearchStore(path)
      open = true
      expect(store.search({ query: 'newneedle' }).hits).toHaveLength(0)
      expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
      expect(store.indexedFile('synthetic-transcript', null)?.byteOffset).toBe(1)
      await store.purgeOlderThan(null)
      expect(store.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 })
      await store.apply(update('newneedle', 1000, mode))
      expect(store.search({ query: 'newneedle' }).hits).toHaveLength(1)
    } finally {
      if (open) {
        store.close()
      }
      await removeTree(root)
    }
  }
)

it('does not resurrect a newly invalidated file or retain a cancelled append', async () => {
  const store = new SessionSearchStore(':memory:')
  const writer = new SessionSearchIndexWriter(store.db)
  try {
    expect(
      await writer.apply(
        update('newneedle', 1000),
        () => true,
        async () => {
          writer.removeFile('synthetic-transcript')
        }
      )
    ).toBe(false)
    expect(store.search({ query: 'newneedle' }).hits).toHaveLength(0)
    await store.purgeOlderThan(null)
    await writer.apply(update('oldneedle', 1))
    let accepted = true
    expect(
      await writer.apply(
        update('newneedle', 1000, 'append'),
        () => accepted,
        async () => {
          accepted = false
        },
        () => true
      )
    ).toBe(false)
    await store.purgeOlderThan(null)
    expect(store.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 })
    expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
  } finally {
    store.close()
  }
})

it('does not suggest unpublished vocabulary while a large update is being written', async () => {
  const store = new SessionSearchStore(':memory:')
  const writer = new SessionSearchIndexWriter(store.db)
  try {
    await writer.apply(update('oldneedle', 1))
    await writer.apply(
      update('coalesces', 1000, 'append'),
      () => true,
      async () => {
        const result = store.search({ query: 'coalescs' })
        expect(result.hits).toHaveLength(0)
        expect(result.repairedTerms).toBeUndefined()
      }
    )
    expect(store.search({ query: 'coalescs' }).repairedTerms).toEqual(['coalesces'])
  } finally {
    store.close()
  }
})
