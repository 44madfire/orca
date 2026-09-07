import { afterEach, expect, it, vi } from 'vitest'
import { SessionSearchIndexingProgress } from './session-search-indexing-progress'

afterEach(() => vi.useRealTimers())

it('keeps discovery indeterminate and retains partial progress on pause', () => {
  const progress = new SessionSearchIndexingProgress()
  progress.discover()
  expect(progress.snapshot()).toMatchObject({ phase: 'discovering', filesTotal: null })
  progress.discovered(3, 0)
  progress.processed(false)
  progress.setPaused(true)
  progress.finish()
  expect(progress.snapshot()).toMatchObject({ phase: 'paused', filesTotal: 3, filesProcessed: 1 })
})

it('reports scan and parse failures without claiming the index is complete, and resets on retry', () => {
  const progress = new SessionSearchIndexingProgress()
  progress.discover()
  progress.discovered(2, 1)
  progress.processed(true)
  progress.processed(false)
  progress.finish()
  expect(progress.snapshot()).toMatchObject({ phase: 'error', failures: 2, filesProcessed: 2 })
  progress.discover()
  progress.discovered(2, 0)
  progress.processed(false)
  progress.processed(false)
  progress.finish()
  expect(progress.snapshot()).toMatchObject({ phase: 'complete', failures: 0 })
})

it('groups adjacent live writes into one burst and keeps failures visible', () => {
  vi.useFakeTimers()
  const progress = new SessionSearchIndexingProgress()
  const first = progress.beginWrite()
  const startedAt = progress.snapshot().startedAt
  vi.advanceTimersByTime(5000)
  first()
  const second = progress.beginWrite()
  expect(progress.snapshot()).toMatchObject({ phase: 'updating', filesTotal: 2, startedAt })
  progress.writeFailed()
  second()
  expect(progress.snapshot().phase).toBe('error')
  progress.beginWrite()()
  expect(progress.snapshot().phase).toBe('error')
})

it('a write from an older pass does not advance a new backfill', () => {
  const progress = new SessionSearchIndexingProgress()
  const finish = progress.beginWrite()
  progress.discover()
  progress.discovered(4, 0)
  finish()
  expect(progress.snapshot()).toMatchObject({ phase: 'indexing', filesTotal: 4, filesProcessed: 0 })
})
