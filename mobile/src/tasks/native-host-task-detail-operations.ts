import type { HostTaskGitLabDetail } from './host-task-provider-payloads'
import type { DetailComment, LinearIssue } from './mobile-tasks-provider-detail-types'
import type { HostTaskDetailOperations } from './host-task-detail-operations'
import { projectGitHubTaskDetail } from './github-task-detail-projection'
import type { RpcRequestSender } from '../transport/rpc-client'

type GitLabRawDetails = Partial<HostTaskGitLabDetail> & {
  item?: {
    labels?: string[]
    mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  }
}

export function nativeHostTaskDetailOperations(client: RpcRequestSender): HostTaskDetailOperations {
  return {
    async listGitHubLabels(repoId) {
      return successfulResult(
        client.sendRequest('github.listLabels', { repo: `id:${repoId}` }, { timeoutMs: 30_000 })
      )
    },
    async listGitHubAssignableUsers(repoId) {
      return successfulResult(
        client.sendRequest(
          'github.listAssignableUsers',
          { repo: `id:${repoId}` },
          { timeoutMs: 30_000 }
        )
      )
    },
    async loadGitHub(payload) {
      const details = await successfulResult<unknown>(
        client.sendRequest(
          'github.workItemDetails',
          {
            repo: `id:${payload.repoId}`,
            number: payload.number,
            type: payload.type
          },
          { timeoutMs: 30_000 }
        )
      )
      return projectGitHubTaskDetail(details)
    },
    async loadGitLab(payload) {
      const details = await successfulResult<GitLabRawDetails | null>(
        client.sendRequest(
          'gitlab.workItemDetails',
          {
            repo: `id:${payload.repoId}`,
            iid: payload.number,
            type: payload.type,
            projectRef: payload.projectRef
          },
          { timeoutMs: 30_000 }
        )
      )
      if (!details) {
        throw new Error('Details not found')
      }
      return {
        body: details.body ?? '',
        comments: details.comments ?? [],
        labels: details.item?.labels ?? details.labels,
        assignees: details.assignees ?? [],
        pipelineJobs: details.pipelineJobs ?? [],
        ...(details.item?.mergeable ? { item: { mergeable: details.item.mergeable } } : {}),
        ...(details.reviewers ? { reviewers: details.reviewers } : {}),
        ...(details.approvalState ? { approvalState: details.approvalState } : {})
      }
    },
    async loadLinear(payload) {
      const [issueResponse, commentsResponse] = await Promise.all([
        client.sendRequest(
          'linear.getIssue',
          { id: payload.issueId, workspaceId: payload.workspaceId },
          { timeoutMs: 30_000 }
        ),
        client.sendRequest(
          'linear.issueComments',
          { issueId: payload.issueId, workspaceId: payload.workspaceId },
          { timeoutMs: 30_000 }
        )
      ])
      const issue = await successfulResult<LinearIssue | null>(issueResponse)
      const comments = await optionalComments(commentsResponse)
      if (!issue) {
        throw new Error('Details not found')
      }
      return { issue, comments }
    }
  }
}

/** Tolerates a refusal envelope only. A transport rejection still fails the detail load, so a
 *  timed-out comment read cannot render as an issue that simply has no comments. */
async function optionalComments(request: Promise<unknown>): Promise<DetailComment[]> {
  const response = (await request) as { ok: boolean; result?: unknown }
  return response.ok ? ((response.result as DetailComment[]) ?? []) : []
}

async function successfulResult<T>(request: Promise<unknown>): Promise<T> {
  const response = (await request) as {
    ok: boolean
    result?: unknown
    error?: { message?: string }
  }
  if (!response.ok) {
    throw new Error(response.error?.message ?? 'Task provider request failed')
  }
  return response.result as T
}
