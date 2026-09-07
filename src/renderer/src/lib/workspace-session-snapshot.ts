import type { AppState } from '../store'

export type WorkspaceSessionSnapshot = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorkspaceKey'
  | 'activeWorktreeId'
  | 'activeTabId'
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'activeTabIdByWorktree'
  | 'openFiles'
  | 'editorDrafts'
  | 'markdownFrontmatterVisible'
  | 'activeFileIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'browserTabsByWorktree'
  | 'browserPagesByWorkspace'
  | 'activeBrowserTabIdByWorktree'
  | 'browserUrlHistory'
  | 'workspaceDocHistory'
  | 'remoteBrowserPageHandlesByPageId'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'activeGroupIdByWorktree'
  | 'sshConnectionStates'
  | 'repos'
  | 'worktreesByRepo'
  | 'lastKnownRelayPtyIdByTabId'
  | 'lastVisitedAtByWorktreeId'
  | 'defaultTerminalTabsAppliedByWorktreeId'
  | 'closedTerminalTabTombstonesByTabId'
> & {
  activeWorkspaceExecutionHostId?: AppState['activeWorkspaceExecutionHostId']
  sleepingAgentSessionsByPaneKey?: AppState['sleepingAgentSessionsByPaneKey']
  clientHostedBrowserCloseIntentsByEnvironment?: AppState['clientHostedBrowserCloseIntentsByEnvironment']
  /** Optional so the many partial snapshot fixtures keep type-checking; see buildTerminalSessionData. */
  pendingReconnectPtyIdByTabId?: AppState['pendingReconnectPtyIdByTabId']
  deferredSshSessionIdsByTabId?: AppState['deferredSshSessionIdsByTabId']
}

// Why: shallow-equality gate for the debounced session writer; _exhaustive below keeps it in sync with the snapshot type.
export const SESSION_RELEVANT_FIELDS = [
  'activeRepoId',
  'activeWorkspaceKey',
  'activeWorkspaceExecutionHostId',
  'activeWorktreeId',
  'activeTabId',
  'tabsByWorktree',
  'ptyIdsByTabId',
  'terminalLayoutsByTabId',
  'activeTabIdByWorktree',
  'openFiles',
  'editorDrafts',
  'markdownFrontmatterVisible',
  'activeFileIdByWorktree',
  'activeTabTypeByWorktree',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'activeBrowserTabIdByWorktree',
  'browserUrlHistory',
  'workspaceDocHistory',
  'remoteBrowserPageHandlesByPageId',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'activeGroupIdByWorktree',
  'sshConnectionStates',
  'repos',
  'worktreesByRepo',
  'lastKnownRelayPtyIdByTabId',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId',
  'closedTerminalTabTombstonesByTabId',
  'sleepingAgentSessionsByPaneKey',
  'clientHostedBrowserCloseIntentsByEnvironment',
  'pendingReconnectPtyIdByTabId',
  'deferredSshSessionIdsByTabId'
] as const satisfies readonly (keyof WorkspaceSessionSnapshot)[]

type _MissingSessionField = Exclude<
  keyof WorkspaceSessionSnapshot,
  (typeof SESSION_RELEVANT_FIELDS)[number]
>
void (true satisfies [_MissingSessionField] extends [never] ? true : never)
