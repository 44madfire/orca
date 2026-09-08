import { useMemo } from 'react'
import { comparePaletteRankedItems } from '@/lib/cmd-j-section-leadership'
import { getPaletteWorktreeIdentity } from '@/lib/palette-repo-resolution'
import type {
  BrowserPaletteItem,
  OpenTabPaletteItem,
  SimulatorPaletteItem,
  WorkspaceTabPaletteItem,
  WorktreePaletteItem
} from './worktree-jump-palette-model'
import { encodePaletteIdentity } from '@/lib/palette-match/palette-ranking'
import {
  buildBrowserPaletteItems,
  buildOpenTabPaletteItems,
  buildSimulatorPaletteItems,
  buildWorkspaceTabPaletteItems
} from './worktree-jump-palette-open-tab-items'
import {
  useWorktreeJumpPaletteTabSearch,
  type WorktreeJumpPaletteTabSearchInput
} from './use-worktree-jump-palette-tab-search'

export function useWorktreeJumpPaletteOpenTabs(input: WorktreeJumpPaletteTabSearchInput) {
  const { hasQuery, resolveWorktree, worktreeMatches } = input
  const {
    browserMatches,
    browserPageEntries,
    simulatorMatches,
    simulatorTabEntries,
    workspaceTabEntries,
    workspaceTabMatches
  } = useWorktreeJumpPaletteTabSearch(input)
  const worktreeItems = useMemo<WorktreePaletteItem[]>(() => {
    const items = worktreeMatches
      .map((match) => {
        const worktree = resolveWorktree(match.worktreeId, match.worktreeHostId)
        return worktree
          ? {
              id: encodePaletteIdentity(['worktree', getPaletteWorktreeIdentity(worktree)]),
              type: 'worktree' as const,
              match,
              worktree
            }
          : null
      })
      .filter((item): item is WorktreePaletteItem => item !== null)
    if (!hasQuery) {
      return items
    }
    const orderByIdentity = new Map(
      items.map((item, index) => [getPaletteWorktreeIdentity(item.worktree), index])
    )
    return items.sort((left, right) =>
      comparePaletteRankedItems(
        {
          rank: left.match.rank,
          order: orderByIdentity.get(getPaletteWorktreeIdentity(left.worktree)) ?? 0,
          identity: left.id,
          activity: left.match.activity
        },
        {
          rank: right.match.rank,
          order: orderByIdentity.get(getPaletteWorktreeIdentity(right.worktree)) ?? 0,
          identity: right.id,
          activity: right.match.activity
        }
      )
    )
  }, [hasQuery, resolveWorktree, worktreeMatches])
  const browserItems = useMemo<BrowserPaletteItem[]>(
    () => buildBrowserPaletteItems(browserMatches),
    [browserMatches]
  )
  const simulatorItems = useMemo<SimulatorPaletteItem[]>(
    () => buildSimulatorPaletteItems(simulatorMatches),
    [simulatorMatches]
  )
  const workspaceTabItems = useMemo<WorkspaceTabPaletteItem[]>(
    () => buildWorkspaceTabPaletteItems(workspaceTabMatches),
    [workspaceTabMatches]
  )
  const openTabItems = useMemo<OpenTabPaletteItem[]>(
    () => buildOpenTabPaletteItems({ browserItems, simulatorItems, workspaceTabItems }),
    [browserItems, simulatorItems, workspaceTabItems]
  )

  return {
    browserPageEntries,
    simulatorTabEntries,
    workspaceTabEntries,
    worktreeItems,
    browserItems,
    simulatorItems,
    workspaceTabItems,
    openTabItems
  }
}

export type WorktreeJumpPaletteOpenTabs = ReturnType<typeof useWorktreeJumpPaletteOpenTabs>
