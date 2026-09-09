import type { GitHubOwnerRepo } from '../../../src/shared/github/pull-request-types'
import type {
  HostTaskBootstrap,
  HostTaskLinearStatus,
  HostTaskLinearTeams,
  HostTaskRepository
} from './host-task-runtime-payloads'

export type { HostTaskBootstrap, HostTaskLinearStatus, HostTaskLinearTeams, HostTaskRepository }

export type HostTaskReadOperations = {
  bootstrap(): Promise<HostTaskBootstrap>
  listRepositories(): Promise<HostTaskRepository[]>
  /** Split from the team read so a caller can commit the workspace list before asking for
   *  teams: a failed team read must not discard the workspaces the status already named. */
  linearStatus(): Promise<HostTaskLinearStatus>
  linearTeams(workspaceId: string | null): Promise<HostTaskLinearTeams>
  resolveGitHubRepoSlug(repoId: string): Promise<GitHubOwnerRepo | null>
}
