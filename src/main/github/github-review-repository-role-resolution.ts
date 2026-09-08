import { githubRepoIdentityKey } from '../../shared/github/repository-identity-key'
import { resolveGitOperationRemoteRoles } from '../git/git-operation-remote-roles'
import type { GitHubApiRepository } from './github-api-repository'
import type { LocalGitExecOptions } from './gh-utils'

type ResolveRemote = (remoteName: string) => Promise<GitHubApiRepository | null>
export type GitHubApiRepositoryCandidates = {
  candidates: GitHubApiRepository[]
  headRepo: GitHubApiRepository | null
  headAmbiguous?: boolean
}

async function resolveConventionalCandidates(
  resolveRemote: ResolveRemote
): Promise<GitHubApiRepositoryCandidates> {
  const [upstream, origin] = await Promise.all([resolveRemote('upstream'), resolveRemote('origin')])
  const seen = new Set<string>()
  const candidates = [upstream, origin].filter((candidate): candidate is GitHubApiRepository => {
    if (!candidate) {
      return false
    }
    const key = githubRepoIdentityKey(candidate)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
  return { candidates, headRepo: origin }
}

export async function resolveGitHubReviewRepositoryRoles(args: {
  repoPath: string
  branchName?: string
  connectionId?: string | null
  localGitOptions: LocalGitExecOptions
  resolveRemote: ResolveRemote
}): Promise<GitHubApiRepositoryCandidates> {
  if (!args.branchName) {
    return resolveConventionalCandidates(args.resolveRemote)
  }
  const repositoriesByRemote = new Map<string, GitHubApiRepository>()
  const roles = await resolveGitOperationRemoteRoles({
    repoPath: args.repoPath,
    branchName: args.branchName,
    connectionId: args.connectionId,
    localGitOptions: args.localGitOptions,
    eligibleRemotes: async (remoteNames) => {
      const repositories = await Promise.all(remoteNames.map(args.resolveRemote))
      return remoteNames.filter((remoteName, index) => {
        const repository = repositories[index]
        if (!repository) {
          return false
        }
        repositoriesByRemote.set(remoteName, repository)
        return true
      })
    }
  })
  const seen = new Set<string>()
  const reviewBaseRemoteNames =
    roles.reviewBase.kind === 'candidates' ? roles.reviewBase.remoteNames : []
  const candidates = reviewBaseRemoteNames.flatMap((remoteName) => {
    const repository = repositoriesByRemote.get(remoteName)
    if (!repository) {
      return []
    }
    const key = githubRepoIdentityKey(repository)
    if (seen.has(key)) {
      return []
    }
    seen.add(key)
    return [repository]
  })
  const headRepo =
    roles.head.kind === 'resolved'
      ? (repositoriesByRemote.get(roles.head.remoteName) ?? null)
      : null
  return {
    candidates,
    headRepo,
    ...(roles.head.kind === 'ambiguous' ? { headAmbiguous: true } : {})
  }
}
