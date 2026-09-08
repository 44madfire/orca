import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId
} from '../../shared/execution-host'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { linkedReviewOperationTarget } from '../../shared/linked-review-operation-target'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { readAllWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getLocalWorktreePathAccess } from '../local-worktree-filesystem'
import { listRepoWorktreesForDetectedScan } from '../repo-worktrees'
import { getLocalGitOptionsForRepo } from './local-worktree-runtime-options'
import { isENOENT } from './filesystem-path-containment'
import type { Store } from '../persistence'

export async function resolveReviewPushWorkspace(
  store: Store,
  args: {
    worktreePath: string
    worktreeId?: string
    connectionId?: string
    pushTarget?: GitPushTarget
  }
): Promise<{
  worktreePath: string
  pushTarget?: GitPushTarget
  gitOptions: { wslDistro?: string }
}> {
  const host = args.connectionId ? toSshExecutionHostId(args.connectionId) : LOCAL_EXECUTION_HOST_ID
  const repos = store.getRepos().filter((repo) => getRepoExecutionHostId(repo) === host)
  const metadata = Object.entries(readAllWorktreeMetaForHost(store, host))
  if (
    !args.worktreePath ||
    args.worktreePath.includes('\0') ||
    repos.length > 128 ||
    metadata.length > 512
  ) {
    throw new Error('Review push workspace identity is unverifiable.')
  }
  const remoteFilesystem = args.connectionId
    ? requireSshFilesystemProvider(args.connectionId)
    : null
  const matches: {
    id: string
    path: string
    meta?: WorktreeMeta
    gitOptions: { wslDistro?: string }
  }[] = []
  for (const repo of repos) {
    const gitOptions = remoteFilesystem ? {} : getLocalGitOptionsForRepo(store, repo)
    const filesystem = remoteFilesystem ?? getLocalWorktreePathAccess(gitOptions)
    const canonicalize = (path: string) => filesystem.realpath(path)
    const target = await canonicalize(args.worktreePath)
    const owned = metadata.filter(([id]) => splitWorktreeIdForFilesystem(id)?.repoId === repo.id)
    for (const [id, meta] of owned) {
      const path = splitWorktreeIdForFilesystem(id)!.worktreePath
      let canonical: string
      try {
        canonical = await canonicalize(path)
      } catch (error) {
        if (isENOENT(error) && !linkedReviewOperationTarget(meta)) {
          continue
        }
        throw error
      }
      if (canonical === target) {
        matches.push({ id, path: canonical, meta, gitOptions })
      }
    }
    if (matches.some((match) => owned.some(([id]) => id === match.id))) {
      continue
    }
    // A successful host catalog establishes ordinary unlinked work; absent metadata cannot.
    for (const row of await listRepoWorktreesForDetectedScan(repo, gitOptions)) {
      if ((await canonicalize(row.path)) === target) {
        matches.push({ id: `${repo.id}::${row.path}`, path: target, gitOptions })
      }
    }
  }
  const selected = args.worktreeId
    ? matches.filter((match) => match.id === args.worktreeId)
    : matches
  if (selected.length !== 1) {
    throw new Error(
      `Review push workspace identity is ${selected.length ? 'ambiguous' : 'unverifiable'}.`
    )
  }
  const owner = selected[0]!
  const currentMeta = readAllWorktreeMetaForHost(store, host)[owner.id]
  if (owner.meta && !currentMeta) {
    throw new Error('Review push workspace metadata changed during identity resolution.')
  }
  return {
    worktreePath: owner.path,
    gitOptions: owner.gitOptions,
    pushTarget: linkedReviewOperationTarget(currentMeta, args.pushTarget)
  }
}

export async function resolveStoredReviewPushTarget(
  store: Store,
  args: Parameters<typeof resolveReviewPushWorkspace>[1]
): Promise<GitPushTarget | undefined> {
  return (await resolveReviewPushWorkspace(store, args)).pushTarget
}
