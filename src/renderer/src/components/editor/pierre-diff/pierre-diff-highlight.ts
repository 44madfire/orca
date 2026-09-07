import { getFiletypeFromFileName, type FileDiffMetadata } from '@pierre/diffs'
import { createDiffHighlightPool } from './pierre-diff-highlight-pool'

export function preparePierreDiffHighlight(
  diff: FileDiffMetadata,
  signal: AbortSignal
): Promise<void> {
  const language = diff.lang ?? getFiletypeFromFileName(diff.name)
  const previousLanguage =
    diff.lang ?? (diff.prevName ? getFiletypeFromFileName(diff.prevName) : 'text')
  if (signal.aborted) {
    return Promise.reject(new DOMException('Canceled', 'AbortError'))
  }
  if (language === 'text' && previousLanguage === 'text') {
    return Promise.resolve()
  }
  const pool = createDiffHighlightPool()
  if (!pool.isWorkingPool()) {
    return Promise.reject(new Error('Diff highlighting worker is unavailable. Retry this file.'))
  }
  if (pool.getDiffResultCache(diff)) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      signal.removeEventListener('abort', abort)
      pool.cleanUpTasks(renderer)
      if (error !== undefined) {
        reject(error)
      } else {
        resolve()
      }
    }
    const abort = () => finish(new DOMException('Canceled', 'AbortError'))
    const renderer = {
      __id: `orca-highlight:${diff.cacheKey}`,
      onHighlightSuccess: () => finish(),
      onHighlightError: (error: unknown) => finish(error)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      pool.highlightDiffAST(renderer, diff)
    } catch (error) {
      finish(error)
    }
  })
}
