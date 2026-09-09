import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Repo } from '../shared/repo-types'
import type { ProjectHostSetupUpdateArgs } from '../shared/project-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'

/** The store surface a relocation needs; keeps this callable from the IPC and RPC entry points alike. */
export type ProjectPathRelocationStore = {
  getRepo: (id: string) => Repo | undefined
  getRepos: () => Repo[]
  relocateRepoPath: (repoId: string, newPath: string) => Repo | null
}

export type ProjectPathRelocationResult =
  | { readonly outcome: 'relocated'; readonly repo: Repo }
  | { readonly outcome: 'unchanged'; readonly repo: Repo }
  | { readonly outcome: 'refused'; readonly error: string }

function isExistingDirectory(pathValue: string): boolean {
  try {
    return statSync(pathValue).isDirectory()
  } catch {
    return false
  }
}

/**
 * Move a registered project to the directory it now lives in, keeping its id, its workspaces and
 * their sessions. The single authority for a project path change: `updateRepo` deliberately cannot
 * take `path`, because every workspace id is derived from it.
 *
 * Refuses rather than guesses. A project on an SSH host is checked by the host that runs it, never
 * from here, so a remote relocation is declined outright instead of validated against local disk.
 */
export function relocateProjectPath(
  store: ProjectPathRelocationStore,
  repoId: string,
  rawNewPath: string,
  options: { directoryExists?: (path: string) => boolean } = {}
): ProjectPathRelocationResult {
  const directoryExists = options.directoryExists ?? isExistingDirectory
  const repo = store.getRepo(repoId)
  if (!repo) {
    return { outcome: 'refused', error: `Project not found: ${repoId}` }
  }
  const newPath = rawNewPath.trim()
  if (!newPath || !isAbsolute(newPath)) {
    return { outcome: 'refused', error: 'The new project location must be an absolute path.' }
  }
  if (normalizeRuntimePathForComparison(newPath) === normalizeRuntimePathForComparison(repo.path)) {
    return { outcome: 'unchanged', repo }
  }
  if (repo.connectionId || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return {
      outcome: 'refused',
      error:
        'Only a project on this machine can be moved from here. Re-import a project that runs on another host from that host.'
    }
  }
  const newPathKey = normalizeRuntimePathForComparison(newPath)
  const occupant = store
    .getRepos()
    .find(
      (candidate) =>
        candidate.id !== repo.id && normalizeRuntimePathForComparison(candidate.path) === newPathKey
    )
  if (occupant) {
    return {
      outcome: 'refused',
      error: `Another project ("${occupant.displayName}") is already registered at ${newPath}.`
    }
  }
  if (!directoryExists(newPath)) {
    return { outcome: 'refused', error: `No directory exists at ${newPath}.` }
  }
  const relocated = store.relocateRepoPath(repo.id, newPath)
  if (!relocated) {
    return { outcome: 'refused', error: `Project could not be moved: ${repoId}` }
  }
  return { outcome: 'relocated', repo: relocated }
}

/**
 * Resolve the path change a setup update asks for before persistence sees it.
 *
 * A repo-backed setup's path is the project's registered path, so changing it is a relocation, not
 * a field write — persistence refuses it outright for exactly that reason. Both the IPC and RPC
 * entry points run this first so a caller reaching either one gets the same answer, and hand the
 * remaining fields on with `path` already applied.
 */
export function applyProjectHostSetupPathRelocation(
  store: ProjectPathRelocationStore & {
    getProjectHostSetups?: () => readonly { id: string; repoId: string }[]
  },
  args: ProjectHostSetupUpdateArgs,
  options: { directoryExists?: (path: string) => boolean } = {}
): { updates: ProjectHostSetupUpdateArgs['updates']; relocatedRepo: Repo | null } {
  const requestedPath = args.updates.path
  if (requestedPath === undefined) {
    return { updates: args.updates, relocatedRepo: null }
  }
  const setup = store.getProjectHostSetups?.().find((entry) => entry.id === args.setupId)
  const repoId = setup?.repoId
  // An independent setup owns its own `path` field; only a repo-backed one is a project location.
  if (!repoId || !store.getRepo(repoId)) {
    return { updates: args.updates, relocatedRepo: null }
  }
  const result = relocateProjectPath(store, repoId, requestedPath, options)
  if (result.outcome === 'refused') {
    throw new Error(result.error)
  }
  const { path: _path, ...rest } = args.updates
  return {
    updates: rest,
    relocatedRepo: result.outcome === 'relocated' ? result.repo : null
  }
}
