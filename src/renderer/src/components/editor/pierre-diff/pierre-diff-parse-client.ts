import PierreDiffParseWorker from './pierre-diff-parse.worker?worker'
import { getPierreDiffCacheIdentity } from './pierre-diff-cache-identity'
import type { PierreDiffInput } from './pierre-diff-metadata'
import { createPierreDiffParseScheduler } from './pierre-diff-parse-scheduler'
import { preparePierreDiffHighlight } from './pierre-diff-highlight'

const scheduler = createPierreDiffParseScheduler(() => new PierreDiffParseWorker())
let nextRequestId = 0

export async function requestPierreFileDiff(input: PierreDiffInput, signal: AbortSignal) {
  const identity = getPierreDiffCacheIdentity(
    JSON.stringify([
      input.cacheKey,
      input.path,
      input.oldPath,
      input.status,
      input.parseDiffOptions
    ]),
    input.originalContent,
    input.modifiedContent
  )
  const diff = await scheduler.request({ id: ++nextRequestId, identity, input }, signal)
  // Entering Pierre edit mode otherwise highlights the entire file synchronously.
  await preparePierreDiffHighlight(diff, signal)
  return diff
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => scheduler.dispose())
}
