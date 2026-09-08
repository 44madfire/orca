import { SessionSearchResultSchema } from './ai-vault-search-contract'
import type { AiVaultSearchResult } from './ai-vault-search-types'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function snippet(text: string): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= 4096) {
    return text
  }
  let end = 4096
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end))
    } catch {
      end--
    }
  }
  return ''
}

/** Bound before every host transport; never shorten session identities or resume paths. */
export function projectSessionSearchResult(result: AiVaultSearchResult): AiVaultSearchResult {
  const metadata = SessionSearchResultSchema.parse({ ...result, hits: [] })
  const hits: AiVaultSearchResult['hits'] = []
  let truncatedSnippets = result.truncatedSnippets ?? 0
  let omittedHits = result.omittedHits ?? 0
  let bytes = encoder.encode(JSON.stringify(metadata)).length + 256
  if (bytes > 64 * 1024) {
    throw new Error('Search metadata exceeds the response limit.')
  }
  for (const hit of result.hits) {
    const text = snippet(hit.evidence.snippet)
    const projected = { ...hit, evidence: { ...hit.evidence, snippet: text } }
    const size = encoder.encode(JSON.stringify(projected)).length + 1
    if (
      hits.length >= 100 ||
      bytes + size > 512 * 1024 ||
      !SessionSearchResultSchema.shape.hits.element.safeParse(projected).success
    ) {
      omittedHits++
      continue
    }
    if (text !== hit.evidence.snippet) {
      truncatedSnippets++
    }
    bytes += size
    hits.push(projected)
  }
  return SessionSearchResultSchema.parse({
    ...result,
    hits,
    ...(omittedHits ? { omittedHits } : {}),
    ...(truncatedSnippets ? { truncatedSnippets } : {})
  })
}
