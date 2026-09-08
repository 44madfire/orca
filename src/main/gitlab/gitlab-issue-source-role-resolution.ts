import { resolveGitOperationRemoteRoles } from '../git/git-operation-remote-roles'
import { normalizeGitLabHost, type ProjectRef } from './project-ref-parser'

export type GitLabIssueSourceRoleResult = {
  source: ProjectRef | null
  fellBack: false
  ambiguousRemoteNames?: string[]
}

export async function resolveGitLabIssueSourceRole(args: {
  repoPath: string
  knownHosts: readonly string[]
  connectionId?: string | null
  localGitOptions?: { wslDistro?: string }
  resolveRemote: (remoteName: string) => Promise<ProjectRef | null>
}): Promise<GitLabIssueSourceRoleResult> {
  const refsByRemote = new Map<string, ProjectRef>()
  const roles = await resolveGitOperationRemoteRoles({
    repoPath: args.repoPath,
    branchName: '',
    connectionId: args.connectionId,
    localGitOptions: args.localGitOptions,
    providerAuthInventory: args.knownHosts.map(normalizeGitLabHost).sort().join(','),
    eligibleRemotes: async (remoteNames) => {
      const refs = await Promise.all(remoteNames.map(args.resolveRemote))
      return remoteNames.filter((remoteName, index) => {
        const ref = refs[index]
        if (!ref) {
          return false
        }
        refsByRemote.set(remoteName, ref)
        return true
      })
    }
  })
  if (roles.issueSource.kind === 'resolved') {
    return { source: refsByRemote.get(roles.issueSource.remoteName) ?? null, fellBack: false }
  }
  return {
    source: null,
    fellBack: false,
    ...(roles.issueSource.kind === 'ambiguous'
      ? { ambiguousRemoteNames: roles.issueSource.remoteNames }
      : {})
  }
}
