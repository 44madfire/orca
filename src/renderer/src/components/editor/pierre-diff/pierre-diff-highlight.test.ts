import { beforeEach, expect, it, vi } from 'vitest'
import type { FileDiffMetadata } from '@pierre/diffs'
import { preparePierreDiffHighlight } from './pierre-diff-highlight'

const pool = vi.hoisted(() => ({
  getDiffResultCache: vi.fn(),
  cleanUpTasks: vi.fn(),
  highlightDiffAST: vi.fn(),
  isWorkingPool: vi.fn(() => true)
}))
vi.mock('./pierre-diff-highlight-pool', () => ({ createDiffHighlightPool: () => pool }))
const diff = { name: 'file.ts', cacheKey: 'file:1' } as FileDiffMetadata
beforeEach(() => {
  vi.resetAllMocks()
  pool.isWorkingPool.mockReturnValue(true)
})

it('waits for worker highlighting before handing a document to the editor', async () => {
  const promise = preparePierreDiffHighlight(diff, new AbortController().signal)
  expect(pool.highlightDiffAST).toHaveBeenCalledWith(expect.any(Object), diff)
  pool.highlightDiffAST.mock.calls[0][0].onHighlightSuccess()
  await promise
  expect(pool.cleanUpTasks).toHaveBeenCalledWith(pool.highlightDiffAST.mock.calls[0][0])
})

it('removes abandoned highlight requests and rejects stale completion', async () => {
  const controller = new AbortController()
  const promise = preparePierreDiffHighlight(diff, controller.signal)
  const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  pool.highlightDiffAST.mock.calls[0][0].onHighlightSuccess()
  await rejection
  expect(pool.cleanUpTasks).toHaveBeenCalled()
})

it('reuses cached highlighting and skips plain text', async () => {
  pool.getDiffResultCache.mockReturnValue({})
  await preparePierreDiffHighlight(diff, new AbortController().signal)
  pool.getDiffResultCache.mockReset()
  await preparePierreDiffHighlight({ ...diff, name: 'file.txt' }, new AbortController().signal)
  expect(pool.highlightDiffAST).not.toHaveBeenCalled()
})

it('keeps errors recoverable instead of falling back to blocking highlighting', async () => {
  const promise = preparePierreDiffHighlight(diff, new AbortController().signal)
  pool.highlightDiffAST.mock.calls[0][0].onHighlightError(new Error('worker failed'))
  await expect(promise).rejects.toThrow('worker failed')
  pool.isWorkingPool.mockReturnValue(false)
  await expect(preparePierreDiffHighlight(diff, new AbortController().signal)).rejects.toThrow(
    'unavailable'
  )
})
