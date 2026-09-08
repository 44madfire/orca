import type { AppState } from '../../../types'
import type { WorkspaceVisibleTabType } from '../../../../../../shared/tab-types'
import { deriveActiveSurfaceForWorktree } from '../../tabs/tabs-surface'

export function resolveActivatedWorktreeSurface(
  s: Parameters<typeof deriveActiveSurfaceForWorktree>[0] &
    Pick<AppState, 'rightSidebarExplorerViewByWorktree'>,
  worktreeId: string,
  preferredActiveUnifiedTabId: string | undefined,
  reconciledActiveTabId: string | null
): {
  restoredRightSidebarExplorerView: NonNullable<
    AppState['rightSidebarExplorerViewByWorktree']
  >[string]
  activeFileId: string | null
  activeBrowserTabId: string | null
  activeTabType: WorkspaceVisibleTabType
  activeTabId: string | null
} {
  return {
    restoredRightSidebarExplorerView: s.rightSidebarExplorerViewByWorktree?.[worktreeId] ?? 'files',
    ...deriveActiveSurfaceForWorktree(s, worktreeId, undefined, {
      legacySelection: 'remembered-type',
      preferredTabId: preferredActiveUnifiedTabId ?? reconciledActiveTabId ?? undefined
    })
  }
}
