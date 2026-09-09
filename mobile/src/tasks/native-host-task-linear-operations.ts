import type { HostTaskLinearOperations } from './host-task-linear-operations'
import type { RpcRequestSender } from '../transport/rpc-client'
import type { SendRequestOptions } from '../transport/rpc-client'

/** The interactive Linear writes carry their own budget; the reads that only feed a picker do
 *  not, so a slow host degrades the picker instead of the whole screen. */
const INTERACTIVE: SendRequestOptions = { timeoutMs: 30_000 }

export function nativeHostTaskLinearOperations(client: RpcRequestSender): HostTaskLinearOperations {
  return {
    async connect(apiKey) {
      assertMutation(
        await request(client, 'linear.connect', { apiKey }),
        'Failed to connect Linear'
      )
    },
    listTeams: () => request(client, 'linear.listTeams', undefined),
    teamStates: (target) =>
      request(client, 'linear.teamStates', {
        teamId: target.teamId,
        workspaceId: target.workspaceId
      }),
    async selectWorkspace(workspaceId) {
      // Why no result check: the picker already switched, and it reloads the Linear context next.
      // A rejected switch surfaces through that reload, not as a second error on the same tap.
      await client.sendRequest('linear.selectWorkspace', { workspaceId })
    },
    async updateState(target, stateId) {
      await request(client, 'linear.updateIssue', {
        id: target.issueId,
        workspaceId: target.workspaceId,
        updates: { stateId }
      })
    },
    async addComment(target, body) {
      const result = await request<{ ok?: boolean; id?: string; error?: string }>(
        client,
        'linear.addIssueComment',
        { issueId: target.issueId, workspaceId: target.workspaceId, body },
        INTERACTIVE
      )
      assertMutation(result, 'Failed to add comment')
      return result.id
    },
    async loadIssue(target) {
      const issue = await request<Awaited<
        ReturnType<HostTaskLinearOperations['loadIssue']>
      > | null>(
        client,
        'linear.getIssue',
        { id: target.issueId, workspaceId: target.workspaceId },
        INTERACTIVE
      )
      if (!issue) {
        throw new Error('Sub-issue not found')
      }
      return issue
    },
    async createSubIssue(target, title) {
      return createdIssue(
        await request(
          client,
          'linear.createIssue',
          {
            teamId: target.teamId,
            title,
            workspaceId: target.workspaceId,
            parentIssueId: target.issueId,
            projectId: target.projectId ?? null
          },
          INTERACTIVE
        ),
        'Failed to create sub-issue'
      )
    },
    async createIssue(payload) {
      return createdIssue(
        await request(client, 'linear.createIssue', {
          teamId: payload.team.id,
          title: payload.title,
          description: payload.description,
          workspaceId: payload.team.workspaceId
        }),
        'Failed to create Linear issue'
      )
    }
  }
}

async function request<T = unknown>(
  client: RpcRequestSender,
  method: string,
  payload?: object,
  options?: SendRequestOptions
): Promise<T> {
  const response = options
    ? await client.sendRequest(method, payload, options)
    : await client.sendRequest(method, payload)
  if (!response.ok) {
    throw new Error(response.error?.message ?? 'Task request failed')
  }
  return response.result as T
}

function assertMutation(
  result: { ok?: boolean; error?: string } | undefined,
  fallback: string
): void {
  if (result?.ok === false) {
    throw new Error(result.error ?? fallback)
  }
}

function createdIssue(result: unknown, fallback: string) {
  const issue = result as {
    ok?: boolean
    id?: string
    identifier?: string
    title?: string
    url?: string
    error?: string
  }
  if (issue.ok === false || !issue.id || !issue.identifier) {
    throw new Error(issue.error ?? fallback)
  }
  return {
    id: issue.id,
    identifier: issue.identifier,
    ...(issue.title ? { title: issue.title } : {}),
    ...(issue.url ? { url: issue.url } : {})
  }
}
