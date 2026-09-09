import type { HostTaskGitHubDetail } from './host-task-provider-payloads'
import type { GitHubAssignableUser } from './mobile-tasks-provider-detail-types'

type GitHubRawDetails = {
  body?: string
  comments?: HostTaskGitHubDetail['comments']
  assignees?: string[]
  headSha?: string
  baseSha?: string
  pullRequestId?: string
  checks?: HostTaskGitHubDetail['checks']
  files?: HostTaskGitHubDetail['files']

  item?: {
    labels?: string[]
    reviewDecision?: string | null
    reviewRequests?: GitHubAssignableUser[]
    latestReviews?: HostTaskGitHubDetail['latestReviews']
  }
}

export function projectGitHubTaskDetail(value: unknown): HostTaskGitHubDetail {
  const details = value as GitHubRawDetails | null
  if (!details) {
    throw new Error('Details not found')
  }
  return {
    body: details.body ?? '',
    comments: details.comments ?? [],
    labels: details.item?.labels,
    assignees: details.assignees ?? [],
    reviewDecision: details.item?.reviewDecision,
    reviewRequests: details.item?.reviewRequests,
    latestReviews: details.item?.latestReviews,
    headSha: details.headSha,
    baseSha: details.baseSha,
    pullRequestId: details.pullRequestId,
    checks: details.checks ?? [],
    files: details.files ?? []
  }
}
