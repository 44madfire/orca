import type { HostTaskGitHubDetail } from './host-task-provider-payloads'
import type { GitHubAssignableUser } from './mobile-tasks-provider-detail-types'

type GitHubRawDetails = Partial<HostTaskGitHubDetail> & {
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
    labels: details.item?.labels ?? details.labels,
    assignees: details.assignees ?? [],
    reviewDecision: details.item?.reviewDecision ?? details.reviewDecision,
    reviewRequests: details.item?.reviewRequests ?? details.reviewRequests,
    latestReviews: details.item?.latestReviews ?? details.latestReviews,
    headSha: details.headSha,
    baseSha: details.baseSha,
    pullRequestId: details.pullRequestId,
    checks: details.checks ?? [],
    files: details.files ?? []
  }
}
