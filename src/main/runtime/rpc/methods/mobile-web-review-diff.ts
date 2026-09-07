import { createHash } from 'node:crypto'
import {
  MobileWebProviderReviewDiffPayloadSchema,
  MobileWebProviderReviewDiffResultSchema,
  type MobileWebProviderReviewDiffPayload,
  type MobileWebProviderReviewDiffResult
} from '../../../../shared/mobile-web/provider-review-diff-contract'
import type { MobileWebProviderReviewFile } from '../../../../shared/mobile-web/provider-review-contract'
import { defineMethod, type RpcContext } from '../core'
import { projectMobileWebReviewDetails } from './mobile-web-review-projection'
import {
  buildMobileWebReviewContentDiffPage,
  buildMobileWebReviewPatchDiffPage
} from './mobile-web-review-diff-page'
import {
  callMobileWebReviewSource,
  isRecord,
  MobileWebReviewScope,
  mobileWebReviewPayload,
  mobileWebReviewResult,
  readMobileWebReviewTarget
} from './mobile-web-review-scope'
import { gitHubReviewTarget, reviewInlinePosition } from './mobile-web-review-targets'

/** A review diff is the provider's own file contents, not the working tree's, so the page's rows
 *  are paged out of a diff this host builds and clips to one transport payload. */
const MAX_DIFF_RESULT_BYTES = 512 * 1024

export const MOBILE_WEB_REVIEW_DIFF_METHOD = defineMethod({
  name: 'mobileWeb.review.diff',
  params: MobileWebReviewScope.passthrough(),
  handler: async (params, context) => {
    const payload = mobileWebReviewPayload(MobileWebProviderReviewDiffPayloadSchema, params)
    if (payload.provider !== 'github' && payload.provider !== 'gitlab') {
      throw new Error('conflict')
    }
    const { repo, summary, details } = await readMobileWebReviewTarget(context, {
      ...payload,
      worktree: params.worktree
    })
    const review = projectMobileWebReviewDetails(summary, details)
    const file = review.files.find((candidate) => candidate.path === payload.path)
    if (
      review.detailsState !== 'loaded' ||
      review.headSha !== payload.expectedReviewHead ||
      !file
    ) {
      throw new Error('conflict')
    }
    const page =
      payload.provider === 'github'
        ? await readGitHubReviewDiff({ context, repo, payload, details, file })
        : readGitLabReviewDiff(payload, details, file)
    assertRequestedPage(payload, page)
    return mobileWebReviewResult(MobileWebProviderReviewDiffResultSchema.parse(clipDiffRows(page)))
  }
})

async function readGitHubReviewDiff(args: {
  context: RpcContext
  repo: string
  payload: MobileWebProviderReviewDiffPayload
  details: unknown
  file: MobileWebProviderReviewFile
}): Promise<MobileWebProviderReviewDiffResult> {
  const position = reviewInlinePosition(args.details, args.payload.expectedReviewHead)
  if (!position?.baseSha) {
    throw new Error('conflict')
  }
  if (args.file.isBinary) {
    return binaryPage(args.payload)
  }
  const result = await callMobileWebReviewSource(
    'github.prFileContents',
    {
      repo: args.repo,
      prNumber: args.payload.reviewNumber,
      path: args.file.path,
      ...(args.file.oldPath ? { oldPath: args.file.oldPath } : {}),
      status: args.file.status,
      headSha: position.headSha,
      baseSha: position.baseSha,
      ...gitHubReviewTarget(args.details)
    },
    args.context
  )
  if (!isRecord(result)) {
    throw new Error('host_error')
  }
  if (result.originalIsBinary === true || result.modifiedIsBinary === true) {
    return binaryPage(args.payload)
  }
  if (result.originalTooLarge === true || result.modifiedTooLarge === true) {
    return { ...pageIdentity(args.payload), kind: 'too-large', reason: 'host-limit' }
  }
  if (typeof result.original !== 'string' || typeof result.modified !== 'string') {
    throw new Error('host_error')
  }
  return buildMobileWebReviewContentDiffPage({
    ...pageInput(args.payload, diffRevision(result.original, result.modified)),
    originalContent: result.original,
    modifiedContent: result.modified
  })
}

/** GitLab already ships the merge-request patch inside the work item, so no second read is due. */
function readGitLabReviewDiff(
  payload: MobileWebProviderReviewDiffPayload,
  details: unknown,
  file: MobileWebProviderReviewFile
): MobileWebProviderReviewDiffResult {
  if (file.isBinary) {
    return binaryPage(payload)
  }
  const rawFile = providerFile(details, file.path)
  if (!rawFile || typeof rawFile.diff !== 'string') {
    throw new Error('host_error')
  }
  return buildMobileWebReviewPatchDiffPage({
    ...pageInput(payload, diffRevision(rawFile.diff)),
    patch: rawFile.diff
  })
}

/** Escaped line text can exceed the byte budget even within the row-count limit. A focused page
 *  keeps its focus row: the schema requires it, so dropping it would fail the whole read. */
function clipDiffRows(page: MobileWebProviderReviewDiffResult): MobileWebProviderReviewDiffResult {
  if (page.kind !== 'text') {
    return page
  }
  const clipped = { ...page, rows: [...page.rows] }
  while (
    Buffer.byteLength(JSON.stringify(clipped)) > MAX_DIFF_RESULT_BYTES &&
    clipped.rows.length > 1 &&
    clipped.rows.at(-1)?.index !== page.focusRowIndex
  ) {
    clipped.rows.pop()
    clipped.nextOffset = clipped.offset + clipped.rows.length
  }
  return clipped
}

function pageInput(payload: MobileWebProviderReviewDiffPayload, revision: string) {
  return {
    ...pageIdentity(payload),
    revision,
    offset: payload.offset,
    limit: payload.limit,
    ...(payload.focusLine === undefined ? {} : { focusLine: payload.focusLine })
  }
}

function pageIdentity(payload: MobileWebProviderReviewDiffPayload) {
  return {
    workspaceId: payload.workspaceId,
    observedHead: payload.expectedHead,
    branch: payload.expectedBranch,
    provider: payload.provider,
    reviewNumber: payload.reviewNumber,
    reviewHead: payload.expectedReviewHead,
    path: payload.path
  }
}

function binaryPage(
  payload: MobileWebProviderReviewDiffPayload
): MobileWebProviderReviewDiffResult {
  return { ...pageIdentity(payload), kind: 'binary' }
}

/** A page the caller asked to match a revision or centre on a line must do exactly that; anything
 *  else means the review moved between pages. */
function assertRequestedPage(
  payload: MobileWebProviderReviewDiffPayload,
  page: MobileWebProviderReviewDiffResult
): void {
  if (
    payload.expectedRevision &&
    (page.kind !== 'text' || page.revision !== payload.expectedRevision)
  ) {
    throw new Error('conflict')
  }
  if (
    payload.focusLine !== undefined &&
    (page.kind !== 'text' || page.focusLine !== payload.focusLine)
  ) {
    throw new Error('conflict')
  }
}

function providerFile(details: unknown, path: string): Record<string, unknown> | null {
  if (!isRecord(details) || !Array.isArray(details.files)) {
    return null
  }
  const candidate = details.files.find((entry) => isRecord(entry) && entry.path === path)
  return isRecord(candidate) ? candidate : null
}

function diffRevision(...values: string[]): string {
  const digest = createHash('sha256')
  for (const value of values) {
    digest.update(value, 'utf8')
    digest.update(Uint8Array.of(0))
  }
  return digest.digest('hex')
}
