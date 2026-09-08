import type { ExecutionHostId } from '../../../shared/execution-host'
import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import { compareBaseSensitivityLocaleText } from './locale-text-collators'
import {
  comparePaletteTabResults,
  isOmniboxPaletteTabFieldAllowed,
  matchPaletteTabDocument,
  preparePaletteTabQuery
} from './palette-match/tab-match'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import type { MatchRange } from './palette-match/normalized-text'
import type { PaletteDocumentRank } from './palette-match/palette-document'
import type { PaletteResultQualityClass } from './palette-match/match-quality'
import {
  createPaletteSearchContext,
  encodePaletteIdentity,
  maxValidPaletteActivityTimestamp,
  preparePaletteActivity,
  type PaletteActivityRank,
  type PaletteSearchContext
} from './palette-match/palette-ranking'
import { getUnifiedTabPaletteExecutionHostId } from './unified-tab-host-ownership'
import {
  SIMULATOR_TYPE_SEARCH_ALIASES,
  simulatorPaletteTabTitle,
  type SearchableSimulatorTab,
  type SimulatorPaletteTabEntry
} from './simulator-palette-entries'
export {
  buildSearchableSimulatorTabs,
  buildSimulatorPaletteTabEntries,
  prepareSearchableSimulatorTabs,
  SIMULATOR_TYPE_SEARCH_ALIASES,
  simulatorPaletteTabTitle,
  type BuildSearchableSimulatorTabsOptions,
  type SearchableSimulatorTab,
  type SimulatorPaletteTabEntry
} from './simulator-palette-entries'

const NO_RANGES: readonly MatchRange[] = []

export type SimulatorPaletteSearchResult = {
  /** Worktree ids collide across hosts; activation must not resolve by id alone. */
  executionHostId?: ExecutionHostId
  paletteIdentity: string
  tabId: string
  worktreeId: string
  groupId: string
  title: string
  secondaryText: string
  secondaryMatches: readonly { text: string; ranges: readonly MatchRange[] }[]
  repoName: string
  worktreeName: string
  branchName: string
  titleRanges: readonly MatchRange[]
  secondaryRanges: readonly MatchRange[]
  repoRanges: readonly MatchRange[]
  worktreeRanges: readonly MatchRange[]
  branchRanges: readonly MatchRange[]
  typeAliasMatch?: { text: string; ranges: readonly MatchRange[] } | null
  typeAliasMatches: readonly { text: string; ranges: readonly MatchRange[] }[]
  isCurrentTab: boolean
  isCurrentWorktree: boolean
  score: number
  qualityClass: PaletteResultQualityClass | null
  rank: PaletteDocumentRank | null
  lastActiveAt?: number | null
  activity: PaletteActivityRank
}

export const SIMULATOR_PALETTE_QUERY_MAX_BYTES = 2 * 1024

export function isSimulatorPaletteQueryTooLarge(
  query: string,
  maxBytes = SIMULATOR_PALETTE_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

function compareText(a: string, b: string): number {
  return compareBaseSensitivityLocaleText(a, b)
}

function compareEmptyQueryResults(
  a: SimulatorPaletteSearchResult,
  b: SimulatorPaletteSearchResult
): number {
  if (a.isCurrentTab !== b.isCurrentTab) {
    return a.isCurrentTab ? -1 : 1
  }
  if (a.isCurrentWorktree !== b.isCurrentWorktree) {
    return a.isCurrentWorktree ? -1 : 1
  }
  if (a.score !== b.score) {
    return a.score - b.score
  }
  const worktreeCmp = compareText(a.worktreeName, b.worktreeName)
  if (worktreeCmp !== 0) {
    return worktreeCmp
  }
  return compareText(a.title, b.title)
}

// Why: empty-query simulator ordering stays deterministic and context-first;
// lastActiveAt only breaks ties between equally-ranked query matches.
function positionScore(entry: SimulatorPaletteTabEntry): number {
  if (entry.isCurrentTab) {
    return entry.worktreeSortIndex * 100 - 4000
  }
  return entry.worktreeSortIndex * 100 - (entry.isCurrentWorktree ? 1000 : 0)
}

function baseResult(
  entry: SimulatorPaletteTabEntry,
  context: PaletteSearchContext
): SimulatorPaletteSearchResult {
  const executionHostId = getUnifiedTabPaletteExecutionHostId(entry.tab, entry.worktree)
  const activity = preparePaletteActivity(
    maxValidPaletteActivityTimestamp([entry.tab.lastFocusedAt, entry.tab.createdAt]),
    context
  )
  return {
    ...(executionHostId ? { executionHostId } : {}),
    paletteIdentity: encodePaletteIdentity([
      'simulator-tab',
      executionHostId ?? '',
      entry.worktree.id,
      entry.tab.id
    ]),
    tabId: entry.tab.id,
    worktreeId: entry.worktree.id,
    groupId: entry.tab.groupId,
    title: simulatorPaletteTabTitle(entry.tab),
    // Why empty: the smartphone icon already says the type; a fixed label crowds the row.
    secondaryText: '',
    secondaryMatches: [],
    repoName: entry.repoName,
    // Why resolve: a cleared display name leaves the raw field undefined at runtime.
    worktreeName: resolveWorktreeDisplayName(entry.worktree),
    branchName: resolveWorktreeBranchLabel(entry.worktree),
    titleRanges: NO_RANGES,
    secondaryRanges: NO_RANGES,
    repoRanges: NO_RANGES,
    worktreeRanges: NO_RANGES,
    branchRanges: NO_RANGES,
    typeAliasMatches: [],
    isCurrentTab: entry.isCurrentTab,
    isCurrentWorktree: entry.isCurrentWorktree,
    score: positionScore(entry),
    qualityClass: null,
    rank: null,
    lastActiveAt: activity.timestamp || null,
    activity
  }
}

export function listSimulatorTabs(
  entries: readonly SimulatorPaletteTabEntry[],
  options: { context?: PaletteSearchContext } = {}
): SimulatorPaletteSearchResult[] {
  const context = options.context ?? createPaletteSearchContext(Date.now())
  return entries.map((entry) => baseResult(entry, context)).sort(compareEmptyQueryResults)
}

export function searchSimulatorTabs(
  entries: readonly SearchableSimulatorTab[],
  query: string,
  options: { context?: PaletteSearchContext; fieldMode?: 'all' | 'omnibox' } = {}
): SimulatorPaletteSearchResult[] {
  const context = options.context ?? createPaletteSearchContext(Date.now())
  if (isSimulatorPaletteQueryTooLarge(query)) {
    return []
  }
  const prepared = preparePaletteTabQuery(query)
  if (!prepared) {
    return query.trim() ? [] : listSimulatorTabs(entries, { context })
  }

  const results: SimulatorPaletteSearchResult[] = []
  for (const entry of entries) {
    const match = matchPaletteTabDocument(entry.document, prepared, {
      isFieldAllowed: options.fieldMode === 'omnibox' ? isOmniboxPaletteTabFieldAllowed : undefined
    })
    if (!match) {
      continue
    }
    const alias =
      match.typeAlias !== null ? SIMULATOR_TYPE_SEARCH_ALIASES[match.typeAlias.index] : undefined
    results.push({
      ...baseResult(entry, context),
      titleRanges: match.titleRanges,
      repoRanges: match.repoRanges,
      worktreeRanges: match.worktreeRanges,
      branchRanges: match.branchRanges,
      // Ranges are into the alias string, not the row: the icon explains the hit,
      // so nothing on the row is highlighted from them.
      typeAliasMatch: alias ? { text: alias, ranges: match.typeAlias?.ranges ?? NO_RANGES } : null,
      typeAliasMatches: match.typeAliasMatches.map((typeAlias) => ({
        text: SIMULATOR_TYPE_SEARCH_ALIASES[typeAlias.index] ?? '',
        ranges: typeAlias.ranges
      })),
      qualityClass: match.qualityClass,
      rank: match.rank
    })
  }

  return results.sort((a, b) =>
    a.rank && b.rank
      ? comparePaletteTabResults(
          {
            rank: a.rank,
            positionScore: a.score,
            identity: a.paletteIdentity,
            activity: a.activity
          },
          {
            rank: b.rank,
            positionScore: b.score,
            identity: b.paletteIdentity,
            activity: b.activity
          }
        )
      : compareEmptyQueryResults(a, b)
  )
}
