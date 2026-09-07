import { useEffect, useState } from 'react'
import type { DiffSearchRequest, DiffSearchResult } from './pierre-diff-search'

export function usePierreDiffSearchResults(request: DiffSearchRequest | null) {
  const [result, setResult] = useState<{ request: DiffSearchRequest; value: DiffSearchResult }>()
  useEffect(() => {
    if (!request || !request.query.text) {
      return
    }
    let worker: Worker | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const finish = (value: DiffSearchResult) => {
      worker?.terminate()
      clearTimeout(timeout)
      if (!disposed) {
        setResult({ request, value })
      }
    }
    const debounce = setTimeout(() => {
      try {
        worker = new Worker(new URL('./pierre-diff-search.worker.ts', import.meta.url), {
          type: 'module'
        })
        worker.onmessage = ({ data }: MessageEvent<DiffSearchResult>) => finish(data)
        worker.onerror = () =>
          finish({ matches: [], truncated: false, error: 'Could not search this file' })
        worker.onmessageerror = () =>
          finish({ matches: [], truncated: false, error: 'Could not read search results' })
        timeout = setTimeout(
          () =>
            finish({
              matches: [],
              truncated: false,
              error: 'Search took too long. Try a simpler expression.'
            }),
          5_000
        )
        worker.postMessage(request)
      } catch {
        finish({ matches: [], truncated: false, error: 'Could not start search' })
      }
    }, 120)
    return () => {
      disposed = true
      clearTimeout(debounce)
      clearTimeout(timeout)
      worker?.terminate()
    }
  }, [request])
  return result?.request === request ? result.value : null
}
