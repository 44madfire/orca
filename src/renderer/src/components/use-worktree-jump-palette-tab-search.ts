import { useMemo } from 'react'
import {
  buildBrowserPalettePageEntries,
  prepareSearchableBrowserPages
} from '@/lib/browser-palette-page-entries'
import {
  listBrowserPages,
  searchBrowserPages,
  type BrowserPalettePageEntry
} from '@/lib/browser-palette-search'
import {
  buildSimulatorPaletteTabEntries,
  listSimulatorTabs,
  prepareSearchableSimulatorTabs,
  searchSimulatorTabs,
  type SimulatorPaletteTabEntry
} from '@/lib/simulator-palette-search'
import {
  buildWorkspaceTabPaletteEntries,
  listWorkspaceTabs,
  prepareSearchableWorkspaceTabs,
  searchWorkspaceTabs,
  type WorkspaceTabPaletteEntry
} from '@/lib/workspace-tab-palette-search'
import type { PaletteSearchContext } from '@/lib/palette-match/palette-ranking'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'

const EMPTY_BROWSER_PAGE_ENTRIES: BrowserPalettePageEntry[] = []
const EMPTY_SIMULATOR_TAB_ENTRIES: SimulatorPaletteTabEntry[] = []
const EMPTY_WORKSPACE_TAB_ENTRIES: WorkspaceTabPaletteEntry[] = []

type PaletteSearchOptions = { context: PaletteSearchContext }

function usePaletteEntrySearch<Entry, SearchableEntry, Result>({
  entries,
  list,
  prepare,
  query,
  search,
  searchContext
}: {
  entries: readonly Entry[]
  list: (entries: readonly Entry[], options: PaletteSearchOptions) => Result[]
  prepare: (entries: readonly Entry[]) => SearchableEntry[]
  query: string
  search: (
    entries: readonly SearchableEntry[],
    query: string,
    options: PaletteSearchOptions
  ) => Result[]
  searchContext: PaletteSearchContext
}): Result[] {
  const hasQuery = query.length > 0
  const searchableEntries = useMemo(
    () => (hasQuery ? prepare(entries) : []),
    [entries, hasQuery, prepare]
  )
  return useMemo(
    () =>
      hasQuery
        ? search(searchableEntries, query, { context: searchContext })
        : list(entries, { context: searchContext }),
    [entries, hasQuery, list, query, search, searchableEntries, searchContext]
  )
}

export type WorktreeJumpPaletteTabSearchInput = WorktreeJumpPaletteStoreState &
  WorktreeJumpPaletteWorktrees &
  Pick<WorktreeJumpPaletteFilter, 'repoMap' | 'repoByHostIdentity'> &
  Pick<WorktreeJumpPaletteLocalState, 'paletteSearchQuery'> & {
    paletteSearchContext: PaletteSearchContext
  }

export function useWorktreeJumpPaletteTabSearch({
  paletteStatusInputsActive,
  browserSortedWorktrees,
  allWorktrees,
  repoMap,
  repoByHostIdentity,
  worktreeOrder,
  browserTabsByWorktree,
  browserPagesByWorkspace,
  activeBrowserTabId,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  activeTabType,
  unifiedTabsByWorktree,
  activeGroupIdByWorktree,
  groupsByWorktree,
  tabsByWorktree,
  openFiles,
  agentStatusByPaneKey,
  retainedAgentsByPaneKey,
  sleepingAgentSessionsByPaneKey,
  activeTabId,
  activeTabIdByWorktree,
  activeFileId,
  activeFileIdByWorktree,
  activeTabTypeByWorktree,
  settings,
  terminalLayoutsByTabId,
  paneForegroundAgentByPaneKey,
  paletteSearchQuery,
  paletteSearchContext
}: WorktreeJumpPaletteTabSearchInput) {
  const browserPageEntries = useMemo<BrowserPalettePageEntry[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_BROWSER_PAGE_ENTRIES
    }
    return buildBrowserPalettePageEntries({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: allWorktrees,
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
      worktreeOrder,
      browserTabsByWorktree,
      browserPagesByWorkspace,
      activeBrowserTabId,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType,
      unifiedTabsByWorktree
    })
  }, [
    activeBrowserTabId,
    activeTabType,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    allWorktrees,
    browserPagesByWorkspace,
    browserSortedWorktrees,
    browserTabsByWorktree,
    paletteStatusInputsActive,
    repoByHostIdentity,
    repoMap,
    unifiedTabsByWorktree,
    worktreeOrder
  ])
  const browserMatches = usePaletteEntrySearch({
    entries: browserPageEntries,
    list: listBrowserPages,
    prepare: prepareSearchableBrowserPages,
    query: paletteSearchQuery,
    search: searchBrowserPages,
    searchContext: paletteSearchContext
  })
  const simulatorTabEntries = useMemo<SimulatorPaletteTabEntry[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_SIMULATOR_TAB_ENTRIES
    }
    return buildSimulatorPaletteTabEntries({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: allWorktrees,
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
      worktreeOrder,
      unifiedTabsByWorktree,
      activeGroupIdByWorktree,
      groupsByWorktree,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType
    })
  }, [
    activeGroupIdByWorktree,
    activeTabType,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    allWorktrees,
    browserSortedWorktrees,
    groupsByWorktree,
    paletteStatusInputsActive,
    repoByHostIdentity,
    repoMap,
    unifiedTabsByWorktree,
    worktreeOrder
  ])
  const simulatorMatches = usePaletteEntrySearch({
    entries: simulatorTabEntries,
    list: listSimulatorTabs,
    prepare: prepareSearchableSimulatorTabs,
    query: paletteSearchQuery,
    search: searchSimulatorTabs,
    searchContext: paletteSearchContext
  })
  const workspaceTabEntries = useMemo<WorkspaceTabPaletteEntry[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_WORKSPACE_TAB_ENTRIES
    }
    return buildWorkspaceTabPaletteEntries({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: allWorktrees,
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
      worktreeOrder,
      unifiedTabsByWorktree,
      tabsByWorktree,
      openFiles,
      agentStatusByPaneKey,
      retainedAgentsByPaneKey,
      sleepingAgentSessionsByPaneKey,
      activeGroupIdByWorktree,
      groupsByWorktree,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType,
      activeTabId,
      activeTabIdByWorktree,
      activeFileId,
      activeFileIdByWorktree,
      activeTabTypeByWorktree,
      generatedTitlesEnabled: settings?.tabAutoGenerateTitle === true,
      terminalLayoutsByTabId,
      paneForegroundAgentByPaneKey
    })
  }, [
    activeFileId,
    activeFileIdByWorktree,
    activeGroupIdByWorktree,
    activeTabId,
    activeTabIdByWorktree,
    activeTabType,
    activeTabTypeByWorktree,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    agentStatusByPaneKey,
    allWorktrees,
    browserSortedWorktrees,
    groupsByWorktree,
    openFiles,
    paletteStatusInputsActive,
    paneForegroundAgentByPaneKey,
    repoByHostIdentity,
    repoMap,
    retainedAgentsByPaneKey,
    settings?.tabAutoGenerateTitle,
    sleepingAgentSessionsByPaneKey,
    tabsByWorktree,
    terminalLayoutsByTabId,
    unifiedTabsByWorktree,
    worktreeOrder
  ])
  const workspaceTabMatches = usePaletteEntrySearch({
    entries: workspaceTabEntries,
    list: listWorkspaceTabs,
    prepare: prepareSearchableWorkspaceTabs,
    query: paletteSearchQuery,
    search: searchWorkspaceTabs,
    searchContext: paletteSearchContext
  })

  return {
    browserPageEntries,
    browserMatches,
    simulatorTabEntries,
    simulatorMatches,
    workspaceTabEntries,
    workspaceTabMatches
  }
}
