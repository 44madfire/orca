import { mergeMatchRanges, type MatchRange } from './palette-match/normalized-text'
import {
  createPaletteFallbackRank,
  type PaletteDocumentRank
} from './palette-match/palette-document'
import type { PaletteQueryToken } from './palette-match/palette-query'
import type { AgentMetadata } from './workspace-tab-agent-metadata'

/**
 * Agent prompts and assistant messages are deliberately outside the structured tab
 * matcher — they have no evidence contract and no performance gate yet. This
 * fallback preserves the pre-existing ability to find a terminal by what its agent
 * said, as a strictly last-place tier that never contributes to token coverage.
 */
const AGENT_SNIPPET_RANK: PaletteDocumentRank = createPaletteFallbackRank()

export type WorkspaceTabAgentSnippetMatch = {
  text: string
  ranges: readonly MatchRange[]
  rank: PaletteDocumentRank
}

function coverAllTokens(text: string, tokens: readonly PaletteQueryToken[]): MatchRange[] | null {
  // U+0130 is the only code point whose `toLowerCase` lengthens text, and none shrink, so
  // folding it to 'i' first keeps the haystack offset-identical to the original text.
  const haystack = text.includes('İ') ? text.replaceAll('İ', 'i').toLowerCase() : text.toLowerCase()
  const ranges: MatchRange[] = []
  for (const token of tokens) {
    if (token.isPunctuationOnly) {
      return null
    }
    const index = haystack.indexOf(token.text)
    if (index === -1) {
      return null
    }
    ranges.push({ start: index, end: index + token.text.length })
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
        const ranges = coverAllTokens(text, query.tokens)
        if (ranges) {
          return { text, ranges, rank: AGENT_SNIPPET_RANK }
        }
      }
    }
  }
  return null
}
