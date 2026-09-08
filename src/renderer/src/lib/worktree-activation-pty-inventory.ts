import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { PtySessionListScope } from '../../../shared/pty-listed-session'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import {
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
import {
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteState
} from './worktree-operation-route'

export function resolveActivationPtyListScope(
  state: WorktreeOperationRouteState,
  worktreeId: string
): PtySessionListScope {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return { connectionId: null }
  }
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  if (resolution.kind === 'missing' && !getRuntimeEnvironmentIdForWorktree(state, worktreeId)) {
    const repo = resolveIndexedRepoOwner(state.repos, getRepoIdFromWorktreeId(worktreeId))
    const worktree = resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
    // A known native repo remains usable while the unrelated runtime catalog hydrates.
    if (
      repo.kind === 'resolved' &&
      !(state.activeWorktreeId === worktreeId && state.activeWorkspaceExecutionHostId) &&
      (worktree.kind === 'missing' ||
        (worktree.kind === 'resolved' &&
          !worktree.owner.hostId &&
          !worktree.owner.runtimeOwnerEnvironmentId)) &&
      !repo.owner.connectionId &&
      (!repo.owner.executionHostId || repo.owner.executionHostId === 'local')
    ) {
      return { connectionId: null }
    }
  }
  if (resolution.kind !== 'resolved' || resolution.route.runtimeEnvironmentId) {
    throw new Error('workspace activation provider unavailable')
  }
  const host = parseExecutionHostId(resolution.route.executionHostId)
  if (!host || host.kind === 'runtime') {
    // Paired hosts own their activation; a client inventory cannot authorize a writer there.
    throw new Error('workspace activation provider unavailable')
  }
  return { connectionId: host.kind === 'ssh' ? host.targetId : null }
}
