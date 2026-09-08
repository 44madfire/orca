import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab, TabGroup, WorkspaceVisibleTabType } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getPaletteWorktreeIdentity,
  isPaletteCurrentWorktree,
  resolvePaletteRepoForWorktree
} from './palette-repo-resolution'
import { getActiveSimulatorTabId } from './simulator-palette-active-tab'
import { buildPaletteTabDocument } from './palette-match/tab-document'
import type { PaletteDocument } from './palette-match/palette-document'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import {
  findAmbiguousWorktreeIds,
  findDuplicateIds,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'

export type SimulatorPaletteTabEntry = {
  tab: Tab
  worktree: Worktree
  repoName: string
  worktreeSortIndex: number
  isCurrentTab: boolean
  isCurrentWorktree: boolean
}

export type SearchableSimulatorTab = SimulatorPaletteTabEntry & { document: PaletteDocument }

export type BuildSearchableSimulatorTabsOptions = {
  worktrees: readonly Worktree[]
  ownershipWorktrees?: readonly Pick<Worktree, 'id'>[]
  repoMap: ReadonlyMap<string, { displayName?: string | null }>
  repoMapByHostIdentity?: ReadonlyMap<string, { displayName?: string | null }>
  worktreeOrder: ReadonlyMap<string, number>
  unifiedTabsByWorktree: Record<string, readonly Tab[] | undefined>
  activeGroupIdByWorktree: Record<string, string | undefined>
  groupsByWorktree: Record<string, readonly TabGroup[] | undefined>
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
  activeTabType: WorkspaceVisibleTabType
}

// Search-only aliases keep the icon-expressed tab type out of the row text.
export const SIMULATOR_TYPE_SEARCH_ALIASES = [
  'mobile emulator tab',
  'mobile emulator',
  'ios simulator',
  'emulator'
] as const

export function simulatorPaletteTabTitle(tab: Tab): string {
  return tab.label || 'Mobile Emulator'
}

export function buildSimulatorPaletteTabEntries({
  worktrees,
  ownershipWorktrees,
  repoMap,
  repoMapByHostIdentity,
  worktreeOrder,
  unifiedTabsByWorktree,
  activeGroupIdByWorktree,
  groupsByWorktree,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  activeTabType
}: BuildSearchableSimulatorTabsOptions): SimulatorPaletteTabEntry[] {
  const entries: SimulatorPaletteTabEntry[] = []
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(ownershipWorktrees ?? worktrees)
  for (const worktree of worktrees) {
    const repoName =
      resolvePaletteRepoForWorktree(worktree, repoMap, repoMapByHostIdentity)?.displayName ?? ''
    const worktreeSortIndex =
      worktreeOrder.get(getPaletteWorktreeIdentity(worktree)) ??
      worktreeOrder.get(worktree.id) ??
      Number.MAX_SAFE_INTEGER
    const activeUnifiedTabId = getActiveSimulatorTabId({
      worktreeId: worktree.id,
      worktreeHostId: worktree.hostId,
      worktreeRuntimeOwnerEnvironmentId: worktree.runtimeOwnerEnvironmentId,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType,
      activeGroupId: activeGroupIdByWorktree[worktree.id],
      groups: groupsByWorktree[worktree.id]
    })
    const tabs = unifiedTabsByWorktree[worktree.id] ?? []
    const duplicateTabIds = findDuplicateIds(tabs)
    for (const tab of tabs) {
      if (
        duplicateTabIds.has(tab.id) ||
        tab.contentType !== 'simulator' ||
        !isUnifiedTabOwnedByWorktree(tab, worktree, ambiguousWorktreeIds)
      ) {
        continue
      }
      entries.push({
        tab,
        worktree,
        repoName,
        worktreeSortIndex,
        // Simulator tabs are unified tabs; terminal activeTabId misses split-group activation.
        isCurrentTab: activeUnifiedTabId === tab.id,
        isCurrentWorktree: isPaletteCurrentWorktree(
          worktree,
          activeWorktreeId,
          activeWorkspaceExecutionHostId
        )
      })
    }
  }
  return entries
}

export function prepareSearchableSimulatorTabs(
  entries: readonly SimulatorPaletteTabEntry[]
): SearchableSimulatorTab[] {
  return entries.map((entry) => ({
    ...entry,
    document: buildPaletteTabDocument({
      id: entry.tab.id,
      title: simulatorPaletteTabTitle(entry.tab),
      secondaryTexts: [],
      worktreeName: resolveWorktreeDisplayName(entry.worktree),
      branch: resolveWorktreeBranchLabel(entry.worktree),
      repoName: entry.repoName,
      typeAliases: SIMULATOR_TYPE_SEARCH_ALIASES
    })
  }))
}

export function buildSearchableSimulatorTabs(
  options: BuildSearchableSimulatorTabsOptions
): SearchableSimulatorTab[] {
  return prepareSearchableSimulatorTabs(buildSimulatorPaletteTabEntries(options))
}
