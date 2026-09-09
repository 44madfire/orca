import type { GitHubOwnerRepo } from '../../../src/shared/github/pull-request-types'
import type {
  HostTaskBootstrap,
  HostTaskLinearContext,
  HostTaskRepository
} from './host-task-runtime-payloads'

export type { HostTaskBootstrap, HostTaskLinearContext, HostTaskRepository }

export type HostTaskReadOperations = {
  bootstrap(): Promise<HostTaskBootstrap>
  listRepositories(): Promise<HostTaskRepository[]>
  loadLinearContext(): Promise<HostTaskLinearContext>
  resolveGitHubRepoSlug(repoId: string): Promise<GitHubOwnerRepo | null>
}
