import type { DetailComment } from './mobile-tasks-provider-detail-types'
import type {
  HostTaskProjectItemTarget,
  HostTaskProjectMutationOperations
} from './host-task-project-mutation-operations'
import type { RpcRequestSender } from '../transport/rpc-client'
import {
  fetchAddIssueComment,
  fetchAddPRReviewCommentReply,
  fetchMergePR,
  fetchRequestPRReviewers,
  fetchRerunPRChecks,
  fetchResolveReviewThread,
  type GitHubPrMutationOutcome
} from '../session/github-pr-mutations'

const PROJECT_PR_MUTATION_TIMEOUT_MS = 60_000
/** Every project mutation carried a connect deadline before this seam existed. Without one the
 *  transport parks the request through the whole reconnect backoff, roughly six minutes, with
 *  the row's mutation UI disabled and no error. */
const PROJECT_MUTATION_TIMEOUT_MS = 30_000

export function nativeHostTaskProjectMutationOperations(
  client: RpcRequestSender
): HostTaskProjectMutationOperations {
  return {
    async updateItem(target, updates) {
      await projectMutation(
        client,
        target.type === 'issue'
          ? 'github.project.updateIssueBySlug'
          : 'github.project.updatePullRequestBySlug',
        { ...slugPayload(target), updates }
      )
    },
    async addComment(target, body) {
      const result = await projectMutation<{ ok?: boolean; comment?: DetailComment }>(
        client,
        'github.project.addIssueCommentBySlug',
        { ...slugPayload(target), body },
        true
      )
      return result.comment
    },
    async updateComment(target, commentId, body) {
      await projectMutation(client, 'github.project.updateIssueCommentBySlug', {
        owner: target.owner,
        repo: target.repo,
        host: target.host,
        commentId,
        body
      })
    },
    async deleteComment(target, commentId) {
      await projectMutation(client, 'github.project.deleteIssueCommentBySlug', {
        owner: target.owner,
        repo: target.repo,
        host: target.host,
        commentId
      })
    },
    async updateMetadata(target, updates) {
      await projectMutation(client, 'github.project.updateIssueBySlug', {
        ...slugPayload(target),
        updates
      })
    },
    async updateField(target, fieldId, value) {
      await projectMutation(
        client,
        value === null ? 'github.project.clearItemField' : 'github.project.updateItemField',
        value === null
          ? { projectId: target.projectId, host: target.host, itemId: target.itemId, fieldId }
          : {
              projectId: target.projectId,
              host: target.host,
              itemId: target.itemId,
              fieldId,
              value
            }
      )
    },
    async updateIssueType(target, issueTypeId) {
      await projectMutation(client, 'github.project.updateIssueTypeBySlug', {
        ...slugPayload(target),
        issueTypeId
      })
    },
    async resolveReviewThread(target, repoId, threadId, resolve) {
      requirePrMutation(
        await fetchResolveReviewThread(
          client,
          repoId,
          {
            threadId,
            resolve,
            // Why: a draft row
            // has no slug — send it only when one resolved rather than an empty pair.
            prRepo: prRepoPayload(target)
          },
          { timeoutMs: PROJECT_MUTATION_TIMEOUT_MS }
        ),
        resolve ? 'Failed to resolve thread' : 'Failed to reopen thread'
      )
    },
    async replyReviewComment(target, repoId, payload) {
      return prMutationComment(
        await fetchAddPRReviewCommentReply(
          client,
          repoId,
          {
            prNumber: target.number,
            ...payload,
            prRepo: prRepoPayload(target)
          },
          { timeoutMs: PROJECT_MUTATION_TIMEOUT_MS }
        ),
        'Failed to reply'
      )
    },
    async addConversationComment(target, repoId, body) {
      return prMutationComment(
        await fetchAddIssueComment(
          client,
          repoId,
          {
            prNumber: target.number,
            body,
            prRepo: prRepoPayload(target),
            type: target.type
          },
          { timeoutMs: PROJECT_MUTATION_TIMEOUT_MS }
        ),
        'Failed to reply'
      )
    },
    async requestReviewers(target, repoId, reviewers) {
      requirePrMutation(
        await fetchRequestPRReviewers(
          client,
          repoId,
          {
            prNumber: target.number,
            reviewers,
            prRepo: prRepoPayload(target)
          },
          { timeoutMs: PROJECT_MUTATION_TIMEOUT_MS }
        ),
        'Failed to request reviewers'
      )
    },
    async rerunChecks(target, repoId, payload) {
      requirePrMutation(
        await fetchRerunPRChecks(
          client,
          repoId,
          { prNumber: target.number, ...payload, prRepo: prRepoPayload(target) },
          // A CI rerun and a merge both routinely outrun the 30s default.
          { timeoutMs: PROJECT_PR_MUTATION_TIMEOUT_MS }
        ),
        'Failed to rerun checks'
      )
    },
    async merge(target, repoId, method) {
      requirePrMutation(
        await fetchMergePR(
          client,
          repoId,
          { prNumber: target.number, method, prRepo: prRepoPayload(target) },
          { timeoutMs: PROJECT_PR_MUTATION_TIMEOUT_MS }
        ),
        'Failed to merge pull request'
      )
    }
  }
}

/** Fork/GHES decoration the host treats as optional. A row with no repository slug sent `null`
 *  before this seam existed, so refusing the whole call here would lose a working path. */
function prRepoPayload(target: HostTaskProjectItemTarget) {
  return target.owner && target.repo
    ? { owner: target.owner, repo: target.repo, host: target.host }
    : null
}

function slugPayload(target: HostTaskProjectItemTarget) {
  return {
    owner: target.owner,
    repo: target.repo,
    host: target.host,
    number: target.number
  }
}

/** The wording each caller reported for a refused mutation before these calls moved behind the
 *  seam. A host that refuses without a message must still name the action that failed. */
const PROJECT_MUTATION_FALLBACKS: Record<string, string> = {
  'github.project.updateIssueBySlug': 'Failed to update GitHub item',
  'github.project.updatePullRequestBySlug': 'Failed to update GitHub item',
  'github.project.addIssueCommentBySlug': 'Failed to add comment',
  'github.project.updateIssueCommentBySlug': 'Failed to edit comment',
  'github.project.deleteIssueCommentBySlug': 'Failed to delete comment',
  'github.project.updateItemField': 'Failed to update project field',
  'github.project.clearItemField': 'Failed to update project field',
  'github.project.updateIssueTypeBySlug': 'Failed to update issue type'
}

async function projectMutation<T extends object = object>(
  client: RpcRequestSender,
  method: string,
  payload: object,
  requireOk = false
): Promise<T> {
  const fallback = PROJECT_MUTATION_FALLBACKS[method] ?? 'GitHub Project request failed'
  const response = (await client.sendRequest(method, payload, { timeoutMs: 30_000 })) as {
    ok: boolean
    result?: { ok?: boolean; error?: string | { message?: string } }
    error?: { message?: string }
  }
  if (!response.ok) {
    throw new Error(response.error?.message ?? fallback)
  }
  if (requireOk && !response.result?.ok) {
    throw new Error(fallback)
  }
  if (response.result?.ok === false) {
    const error = response.result.error
    throw new Error(typeof error === 'string' ? error : (error?.message ?? fallback))
  }
  return (response.result ?? {}) as T
}

/** The wrapper substitutes its own copy for two cases the caller used to word itself: a host
 *  that says nothing (`Request failed: <method>`) and a review thread it could not update. */
const WRAPPER_SUBSTITUTED_COPY = ['Request failed: ', 'Failed to update review thread.']

function requirePrMutation(result: GitHubPrMutationOutcome, fallback: string): void {
  if (!result.ok) {
    const substituted = WRAPPER_SUBSTITUTED_COPY.some((copy) => result.error.startsWith(copy))
    throw new Error(substituted ? fallback : result.error)
  }
}

function prMutationComment(
  result: GitHubPrMutationOutcome,
  fallback: string
): DetailComment | undefined {
  requirePrMutation(result, fallback)
  return (result as { comment?: DetailComment }).comment
}
