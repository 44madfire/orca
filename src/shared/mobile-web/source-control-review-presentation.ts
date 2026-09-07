import { sha256 } from '../sha256'
import {
  MOBILE_WEB_REVIEW_COMMENT_LIMIT,
  MOBILE_WEB_REVIEW_FILE_STATE_LIMIT,
  MobileWebSourceControlReviewCommentSchema,
  MobileWebSourceControlReviewFileStateSchema,
  MobileWebSourceControlReviewLinkResultSchema,
  MobileWebSourceControlReviewMetadataResultSchema,
  type MobileWebSourceControlReviewComment,
  type MobileWebSourceControlReviewLinkResult,
  type MobileWebSourceControlReviewMetadataResult,
  type MobileWebSourceControlReviewState
} from './source-control-review-contract'
import { MobileWebBrokerError } from './bridge-operation-error'

export function projectMobileWebReviewMetadata(
  worktree: unknown,
  workspaceId: string
): MobileWebSourceControlReviewMetadataResult {
  if (!isRecord(worktree)) {
    throw new MobileWebBrokerError('host_error')
  }
  const rawComments = Array.isArray(worktree.diffComments) ? worktree.diffComments : []
  const rawReview = isRecord(worktree.mobileDiffReview) ? worktree.mobileDiffReview : {}
  const rawFiles = isRecord(rawReview.files) ? Object.values(rawReview.files) : []
  if (
    rawComments.length > MOBILE_WEB_REVIEW_COMMENT_LIMIT ||
    rawFiles.length > MOBILE_WEB_REVIEW_FILE_STATE_LIMIT
  ) {
    throw new MobileWebBrokerError('too_large')
  }
  const comments = rawComments.map(projectComment)
  const reviewState: MobileWebSourceControlReviewState = {
    version: 1,
    ...(safeTimestamp(rawReview.updatedAt) === undefined
      ? {}
      : { updatedAt: safeTimestamp(rawReview.updatedAt) }),
    ...(safeTimestamp(rawReview.completedAt) === undefined
      ? {}
      : { completedAt: safeTimestamp(rawReview.completedAt) }),
    files: rawFiles.map(projectFileState)
  }
  return MobileWebSourceControlReviewMetadataResultSchema.parse({
    workspaceId,
    revision: mobileWebReviewMetadataRevision({ comments, reviewState }),
    comments,
    reviewState
  })
}

export function mobileWebReviewMetadataRevision(value: unknown): string {
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(value))), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

/** The only worktree fields a review write may touch. Everything else on the record stays out of
 * reach of the page. */
export function mobileWebReviewMetadataWorktreeFields(args: {
  worktreeId: string
  comments: readonly MobileWebSourceControlReviewComment[]
  reviewState: MobileWebSourceControlReviewState
}) {
  return {
    diffComments: args.comments.map((comment) => ({
      id: comment.id,
      worktreeId: args.worktreeId,
      filePath: comment.relativePath,
      ...(comment.oldRelativePath ? { oldPath: comment.oldRelativePath } : {}),
      ...(comment.source ? { source: comment.source } : {}),
      ...(comment.selectedText === undefined ? {} : { selectedText: comment.selectedText }),
      ...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
      lineNumber: comment.lineNumber,
      body: comment.body,
      createdAt: comment.createdAt,
      ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
      ...(comment.sentAt === undefined ? {} : { sentAt: comment.sentAt }),
      ...(comment.scope ? { scope: comment.scope } : {}),
      ...(comment.diffIdentity ? { diffIdentity: comment.diffIdentity } : {}),
      side: 'modified'
    })),
    mobileDiffReview: {
      version: 1,
      ...(args.reviewState.updatedAt === undefined
        ? {}
        : { updatedAt: args.reviewState.updatedAt }),
      ...(args.reviewState.completedAt === undefined
        ? {}
        : { completedAt: args.reviewState.completedAt }),
      files: Object.fromEntries(
        args.reviewState.files.map((file) => [
          file.key,
          {
            key: file.key,
            filePath: file.relativePath,
            ...(file.oldRelativePath ? { oldPath: file.oldRelativePath } : {}),
            scope: file.scope,
            ...(file.lastOpenedAt === undefined ? {} : { lastOpenedAt: file.lastOpenedAt }),
            ...(file.lastSeenDiffIdentity
              ? { lastSeenDiffIdentity: file.lastSeenDiffIdentity }
              : {}),
            ...(file.reviewedAt === undefined ? {} : { reviewedAt: file.reviewedAt }),
            ...(file.reviewDiffIdentity ? { reviewDiffIdentity: file.reviewDiffIdentity } : {})
          }
        ])
      )
    }
  }
}

export function projectMobileWebReviewLink(
  worktree: unknown,
  workspaceId: string
): MobileWebSourceControlReviewLinkResult {
  if (!isRecord(worktree)) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebSourceControlReviewLinkResultSchema.parse({
    workspaceId,
    baseRef: boundedText(worktree.baseRef, 512),
    linkedGitHubPR: positiveInteger(worktree.linkedPR),
    linkedGitLabMR: positiveInteger(worktree.linkedGitLabMR),
    linkedBitbucketPR: positiveInteger(worktree.linkedBitbucketPR),
    linkedAzureDevOpsPR: positiveInteger(worktree.linkedAzureDevOpsPR),
    linkedGiteaPR: positiveInteger(worktree.linkedGiteaPR)
  })
}

export function mobileWebReviewLinkWorktreeField(
  provider: string,
  number: number | null
): Record<string, number | null> {
  if (provider === 'github') {
    return { linkedPR: number }
  }
  if (provider === 'gitlab') {
    return { linkedGitLabMR: number }
  }
  if (provider === 'bitbucket') {
    return { linkedBitbucketPR: number }
  }
  if (provider === 'azure-devops') {
    return { linkedAzureDevOpsPR: number }
  }
  return { linkedGiteaPR: number }
}

function projectComment(value: unknown): MobileWebSourceControlReviewComment {
  if (!isRecord(value)) {
    throw new MobileWebBrokerError('host_error')
  }
  const parsed = MobileWebSourceControlReviewCommentSchema.safeParse({
    id: value.id,
    relativePath: value.filePath,
    ...(value.oldPath === undefined ? {} : { oldRelativePath: value.oldPath }),
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.selectedText === undefined ? {} : { selectedText: value.selectedText }),
    ...(value.startLine === undefined ? {} : { startLine: value.startLine }),
    lineNumber: value.lineNumber,
    body: value.body,
    createdAt: value.createdAt,
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
    ...(value.sentAt === undefined ? {} : { sentAt: value.sentAt }),
    ...(value.scope === undefined ? {} : { scope: value.scope }),
    ...(value.diffIdentity === undefined ? {} : { diffIdentity: value.diffIdentity }),
    side: 'modified'
  })
  if (!parsed.success) {
    throw new MobileWebBrokerError('host_error')
  }
  return parsed.data
}

function projectFileState(value: unknown) {
  if (!isRecord(value)) {
    throw new MobileWebBrokerError('host_error')
  }
  const parsed = MobileWebSourceControlReviewFileStateSchema.safeParse({
    key: value.key,
    relativePath: value.filePath,
    ...(value.oldPath === undefined ? {} : { oldRelativePath: value.oldPath }),
    scope: value.scope,
    ...(value.lastOpenedAt === undefined ? {} : { lastOpenedAt: value.lastOpenedAt }),
    ...(value.lastSeenDiffIdentity === undefined
      ? {}
      : { lastSeenDiffIdentity: value.lastSeenDiffIdentity }),
    ...(value.reviewedAt === undefined ? {} : { reviewedAt: value.reviewedAt }),
    ...(value.reviewDiffIdentity === undefined
      ? {}
      : { reviewDiffIdentity: value.reviewDiffIdentity })
  })
  if (!parsed.success) {
    throw new MobileWebBrokerError('host_error')
  }
  return parsed.data
}

function safeTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function boundedText(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
