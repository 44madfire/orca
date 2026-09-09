import type { GitHubOwnerRepo } from '../../../src/shared/github/pull-request-types'
import { MOBILE_TASKS_CAPABILITY } from './mobile-tasks-capability'
import type {
  HostTaskBootstrap,
  HostTaskLinearStatus,
  HostTaskLinearTeams,
  HostTaskReadOperations,
  HostTaskRepository
} from './host-task-read-operations'
import { normalizeLinearStatus } from './linear-status-projection'
import type { RpcRequestSender } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'

export function nativeHostTaskReadOperations(client: RpcRequestSender): HostTaskReadOperations {
  return {
    bootstrap: () => bootstrap(client),
    listRepositories: () => listRepositories(client),
    linearStatus: () => linearStatus(client),
    linearTeams: (workspaceId) => linearTeams(client, workspaceId),
    resolveGitHubRepoSlug: (repoId) => resolveGitHubRepoSlug(client, repoId)
  }
}

async function bootstrap(client: RpcRequestSender): Promise<HostTaskBootstrap> {
  const statusResponse = await client.sendRequest('status.get')
  requireSuccess(statusResponse)
  const status = statusResponse.result as { capabilities?: string[] }
  if (!status.capabilities?.includes(MOBILE_TASKS_CAPABILITY)) {
    return emptyBootstrap(false)
  }
  const [settingsResponse, uiResponse, preflightResponse, linearStatusResponse] = await Promise.all(
    [
      client.sendRequest('settings.get'),
      client.sendRequest('ui.get'),
      client.sendRequest('preflight.check'),
      client.sendRequest('linear.status')
    ]
  )
  const settingsEnvelope = successResult<{ settings?: HostTaskBootstrap['settings'] }>(
    settingsResponse
  )
  const uiEnvelope = successResult<{
    ui?: {
      taskResumeState?: HostTaskBootstrap['taskResumeState']
      trustedOrcaHooks?: HostTaskBootstrap['trustedOrcaHooks']
    }
  }>(uiResponse)
  const preflight = successResult<{ glab?: { installed?: boolean } }>(preflightResponse)
  return {
    supported: true,
    settings: settingsEnvelope?.settings ?? {},
    taskResumeState: uiEnvelope?.ui?.taskResumeState ?? {},
    trustedOrcaHooks: uiEnvelope?.ui?.trustedOrcaHooks ?? {},
    gitLabInstalled: preflight?.glab?.installed === true,
    linearStatus: normalizeLinearStatus(successResult(linearStatusResponse))
  }
}

async function listRepositories(client: RpcRequestSender): Promise<HostTaskRepository[]> {
  const response = await client.sendRequest('repo.list')
  requireSuccess(response)
  const result = response.result as { repos?: HostTaskRepository[] }
  return result.repos ?? []
}

async function linearStatus(client: RpcRequestSender): Promise<HostTaskLinearStatus> {
  const response = await client.sendRequest('linear.status')
  requireSuccess(response)
  return normalizeLinearStatus(response.result)
}

async function linearTeams(
  client: RpcRequestSender,
  workspaceId: string | null
): Promise<HostTaskLinearTeams> {
  const response = await client.sendRequest('linear.listTeams', {
    workspaceId: workspaceId ?? undefined
  })
  requireSuccess(response)
  return response.result as HostTaskLinearTeams
}

async function resolveGitHubRepoSlug(
  client: RpcRequestSender,
  repoId: string
): Promise<GitHubOwnerRepo | null> {
  const response = await client.sendRequest(
    'github.repoSlug',
    { repo: `id:${repoId}` },
    { timeoutMs: 30_000 }
  )
  requireSuccess(response)
  return response.result as GitHubOwnerRepo | null
}

function emptyBootstrap(supported: boolean): HostTaskBootstrap {
  return {
    supported,
    settings: {},
    taskResumeState: {},
    trustedOrcaHooks: {},
    gitLabInstalled: false,
    linearStatus: normalizeLinearStatus(null)
  }
}

function successResult<T>(response: RpcResponse): T | null {
  return response.ok ? (response.result as T) : null
}

function requireSuccess(response: RpcResponse): asserts response is RpcSuccess {
  if (!response.ok) {
    throw new Error(response.error?.message ?? 'Task operation failed')
  }
}
