import { buildPaletteTabDocument } from './palette-match/tab-document'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import { buildWorkspaceTabPaletteEntries } from './workspace-tab-palette-entry-builder'
import type {
  BuildSearchableWorkspaceTabsOptions,
  SearchableWorkspaceTab,
  WorkspaceTabPaletteEntry
} from './workspace-tab-palette-search'

export function prepareSearchableWorkspaceTabs(
  entries: readonly WorkspaceTabPaletteEntry[]
): SearchableWorkspaceTab[] {
  return entries.map((entry) => ({
    ...entry,
    document: buildPaletteTabDocument({
      id: entry.tab.id,
      title: entry.titleSearchText,
      secondaryTexts: entry.secondarySearchTexts,
      worktreeName: resolveWorktreeDisplayName(entry.worktree),
      branch: resolveWorktreeBranchLabel(entry.worktree),
      repoName: entry.repoName,
      typeAliases: entry.typeSearchAliases
    })
  }))
}

export function buildSearchableWorkspaceTabs(
  options: BuildSearchableWorkspaceTabsOptions
): SearchableWorkspaceTab[] {
  return prepareSearchableWorkspaceTabs(buildWorkspaceTabPaletteEntries(options))
}
