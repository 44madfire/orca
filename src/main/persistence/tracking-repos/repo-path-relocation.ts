import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  splitWorktreeId,
  splitWorktreeIdForFilesystem,
  WORKTREE_ID_SEPARATOR
} from '../../../shared/worktree/id'

/** One workspace's path-derived id before and after the project moves. */
export type RepoWorkspaceIdentityMove = {
  readonly from: string
  readonly to: string
}

/**
 * Worktree ids are `<repoId>::<path>` with an optional `::workspace:<uuid>` suffix, so a project's
 * registered path is baked into every workspace that sits at its checkout. Moving the project has to
 * re-key them together; this plans the moves so the caller can apply them through the same
 * identity migration a worktree folder rename uses.
 *
 * Only ids at the checkout itself move. A git project's extra worktrees live under their own base
 * path, which the project path does not own, so relocating the checkout must not rewrite them.
 */
export function planRepoPathRelocation(
  state: PersistedState,
  repo: Pick<Repo, 'id' | 'path'>,
  newPath: string
): RepoWorkspaceIdentityMove[] {
  const oldKey = normalizeRuntimePathForComparison(repo.path)
  if (normalizeRuntimePathForComparison(newPath) === oldKey) {
    return []
  }
  const candidateIds = new Set([
    ...Object.keys(state.worktreeMeta ?? {}),
    ...Object.keys(state.worktreeLineageById ?? {})
  ])
  const moves: RepoWorkspaceIdentityMove[] = []
  for (const worktreeId of candidateIds) {
    const parsed = splitWorktreeId(worktreeId)
    if (!parsed || parsed.repoId !== repo.id) {
      continue
    }
    const filesystemPath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
    if (filesystemPath === undefined) {
      continue
    }
    if (normalizeRuntimePathForComparison(filesystemPath) !== oldKey) {
      continue
    }
    // The instance suffix is whatever the filesystem view stripped; carry it across unchanged so
    // sibling workspaces stay distinct instead of collapsing onto one id.
    const instanceSuffix = parsed.worktreePath.slice(filesystemPath.length)
    moves.push({
      from: worktreeId,
      to: `${repo.id}${WORKTREE_ID_SEPARATOR}${newPath}${instanceSuffix}`
    })
  }
  return moves
}
