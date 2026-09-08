import {
  mapNormalizedRange,
  mergeMatchRanges,
  normalizePaletteText,
  type MatchRange,
  type NormalizedText
} from './palette-match/normalized-text'
import {
  createPaletteFallbackRank,
  type PaletteDocumentRank
} from './palette-match/palette-document'
import type { PaletteQueryToken } from './palette-match/palette-query'
import type { AgentMetadata } from './workspace-tab-agent-metadata'

// Agent text stays a last-place fallback outside structured token coverage.
const AGENT_SNIPPET_RANK: PaletteDocumentRank = createPaletteFallbackRank()

// Closing or rebuilding palette entries releases their Unicode offset maps.
const foldedByMetadata = new WeakMap<readonly AgentMetadata[], Map<string, NormalizedText>>()

export type WorkspaceTabAgentSnippetMatch = {
  text: string
  ranges: readonly MatchRange[]
  rank: PaletteDocumentRank
}

function getFoldedSnippet(text: string, agentMetadata: readonly AgentMetadata[]): NormalizedText {
  let cache = foldedByMetadata.get(agentMetadata)
  if (!cache) {
    cache = new Map()
    foldedByMetadata.set(agentMetadata, cache)
  }
  let folded = cache.get(text)
  if (!folded) {
    folded = normalizePaletteText(text)
    cache.set(text, folded)
  }
  return folded
}

function coverAllTokens(
  text: string,
  tokens: readonly PaletteQueryToken[],
  agentMetadata: readonly AgentMetadata[]
): MatchRange[] | null {
  const lowered = text.toLowerCase()
  const folded = lowered.length === text.length ? null : getFoldedSnippet(text, agentMetadata)
  const haystack = folded ? folded.normalized : lowered
  const ranges: MatchRange[] = []
  for (const token of tokens) {
    if (token.isPunctuationOnly) {
      return null
    }
    const index = haystack.indexOf(token.text)
    if (index === -1) {
      return null
    }
    const end = index + token.text.length
    ranges.push(folded ? mapNormalizedRange(folded, index, end) : { start: index, end })
  }
  return mergeMatchRanges(ranges)
}

export function matchWorkspaceTabAgentSnippet(
  agentMetadata: readonly AgentMetadata[],
  query: { tokens: readonly PaletteQueryToken[] }
): WorkspaceTabAgentSnippetMatch | null {
  for (const source of ['snippetCandidates', 'textParts'] as const) {
    for (const metadata of agentMetadata) {
      for (const text of metadata[source]) {
        const ranges = coverAllTokens(text, query.tokens, agentMetadata)
        if (ranges) {
          return { text, ranges, rank: AGENT_SNIPPET_RANK }
        }
      }
    }
  }
  return null
}
