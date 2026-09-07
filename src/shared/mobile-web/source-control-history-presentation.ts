import {
  MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES,
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES,
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_RESPONSE_MAX_BYTES,
  MobileWebGitObjectIdSchema,
  MobileWebGitRefNameSchema,
  MobileWebSourceControlBranchCompareResultSchema,
  MobileWebSourceControlBranchesResultSchema,
  MobileWebSourceControlCommitCompareResultSchema,
  MobileWebSourceControlCompareEntrySchema,
  MobileWebSourceControlHistoryResultSchema,
  type MobileWebSourceControlBranchCompareResult,
  type MobileWebSourceControlBranchesResult,
  type MobileWebSourceControlCommitCompareResult,
  type MobileWebSourceControlCompareEntry,
  type MobileWebSourceControlHistoryItem,
  type MobileWebSourceControlHistoryResult
} from './source-control-history-contract'
import { MobileWebBrokerError } from './bridge-operation-error'
import {
  sanitizeMobileWebHistoryItem,
  sanitizeMobileWebHistoryRef
} from './source-control-history-item-presentation'

const RESPONSE_BUDGET_RESERVE_BYTES = 8 * 1024

export function projectMobileWebBranches(
  result: unknown,
  workspaceId: string
): MobileWebSourceControlBranchesResult {
  if (!isRecord(result) || !Array.isArray(result.branches)) {
    throw new MobileWebBrokerError('host_error')
  }
  const branches = result.branches
    .slice(0, MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT)
    .flatMap((candidate) => {
      const branch = safeGitRef(candidate)
      return branch ? [branch] : []
    })
  return MobileWebSourceControlBranchesResultSchema.parse({
    workspaceId,
    current: safeGitRef(result.current),
    branches,
    totalCount: result.branches.length,
    truncated: branches.length < result.branches.length
  })
}

export function projectMobileWebHistory(
  result: unknown,
  workspaceId: string,
  limit: number
): MobileWebSourceControlHistoryResult {
  if (!isRecord(result) || !Array.isArray(result.items)) {
    throw new MobileWebBrokerError('host_error')
  }
  const items: MobileWebSourceControlHistoryItem[] = []
  let retainedBytes = 0
  let droppedByBudget = false
  for (const candidate of result.items.slice(0, limit)) {
    const item = sanitizeMobileWebHistoryItem(candidate)
    if (!item) {
      continue
    }
    const nextBytes = encodedByteLength(item) + 1
    if (
      retainedBytes + nextBytes >
      MOBILE_WEB_SOURCE_CONTROL_HISTORY_RESPONSE_MAX_BYTES - RESPONSE_BUDGET_RESERVE_BYTES
    ) {
      droppedByBudget = true
      break
    }
    retainedBytes += nextBytes
    items.push(item)
  }
  const currentRef = sanitizeMobileWebHistoryRef(result.currentRef)
  const remoteRef = sanitizeMobileWebHistoryRef(result.remoteRef)
  const baseRef = sanitizeMobileWebHistoryRef(result.baseRef)
  const mergeBase = safeObjectId(result.mergeBase)
  return MobileWebSourceControlHistoryResultSchema.parse({
    workspaceId,
    items,
    ...(currentRef ? { currentRef } : {}),
    ...(remoteRef ? { remoteRef } : {}),
    ...(baseRef ? { baseRef } : {}),
    ...(mergeBase ? { mergeBase } : {}),
    hasIncomingChanges: result.hasIncomingChanges === true,
    hasOutgoingChanges: result.hasOutgoingChanges === true,
    hasMore:
      result.hasMore === true ||
      droppedByBudget ||
      result.items.length > limit ||
      items.length < Math.min(result.items.length, limit),
    limit
  })
}

export function projectMobileWebBranchCompare(
  result: unknown,
  workspaceId: string,
  baseRef: string
): MobileWebSourceControlBranchCompareResult {
  const summary = compareSummary(result)
  const page = compareEntryPage(result)
  const changedFiles = Math.max(page.reportedCount, safeNonnegativeInteger(summary.changedFiles))
  const commitsAhead = optionalNonnegativeInteger(summary.commitsAhead)
  return MobileWebSourceControlBranchCompareResultSchema.parse({
    workspaceId,
    baseRef,
    compareRef: boundedString(summary.compareRef, 240) ?? 'HEAD',
    baseOid: safeObjectId(summary.baseOid),
    headOid: safeObjectId(summary.headOid),
    mergeBase: safeObjectId(summary.mergeBase),
    changedFiles,
    ...(commitsAhead === undefined ? {} : { commitsAhead }),
    status: branchCompareStatus(summary.status),
    entries: page.entries,
    truncated: page.truncated || changedFiles > page.entries.length
  })
}

export function projectMobileWebCommitCompare(
  result: unknown,
  workspaceId: string,
  commitId: string
): MobileWebSourceControlCommitCompareResult {
  const summary = compareSummary(result)
  const page = compareEntryPage(result)
  const changedFiles = Math.max(page.reportedCount, safeNonnegativeInteger(summary.changedFiles))
  return MobileWebSourceControlCommitCompareResultSchema.parse({
    workspaceId,
    commitId,
    commitOid: safeObjectId(summary.commitOid),
    parentOid: safeObjectId(summary.parentOid),
    compareRef: boundedString(summary.compareRef, 240) ?? commitId.slice(0, 12),
    baseRef: boundedString(summary.baseRef, 240) ?? 'parent',
    changedFiles,
    status: commitCompareStatus(summary.status),
    entries: page.entries,
    truncated: page.truncated || changedFiles > page.entries.length
  })
}

/** One response carries the whole compare, so the entry list is bounded by both the entry cap and
 * the bridge response budget rather than by a resumable offset the page would have to drive. */
function compareEntryPage(result: unknown): {
  entries: MobileWebSourceControlCompareEntry[]
  reportedCount: number
  truncated: boolean
} {
  if (!isRecord(result) || !Array.isArray(result.entries)) {
    throw new MobileWebBrokerError('host_error')
  }
  const entries: MobileWebSourceControlCompareEntry[] = []
  let retainedBytes = 0
  let droppedByBudget = false
  for (const candidate of result.entries.slice(0, MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES)) {
    const entry = compareEntry(candidate)
    if (!entry) {
      continue
    }
    const nextBytes = encodedByteLength(entry) + 1
    if (
      retainedBytes + nextBytes >
      MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES - RESPONSE_BUDGET_RESERVE_BYTES
    ) {
      droppedByBudget = true
      break
    }
    retainedBytes += nextBytes
    entries.push(entry)
  }
  return {
    entries,
    reportedCount: result.entries.length,
    truncated: droppedByBudget || entries.length < result.entries.length
  }
}

function compareEntry(candidate: unknown): MobileWebSourceControlCompareEntry | null {
  if (!isRecord(candidate)) {
    return null
  }
  const parsed = MobileWebSourceControlCompareEntrySchema.safeParse({
    relativePath: candidate.path,
    ...(candidate.oldPath === undefined ? {} : { oldRelativePath: candidate.oldPath }),
    status: candidate.status,
    ...(optionalNonnegativeInteger(candidate.added) === undefined
      ? {}
      : { added: candidate.added }),
    ...(optionalNonnegativeInteger(candidate.removed) === undefined
      ? {}
      : { removed: candidate.removed })
  })
  return parsed.success ? parsed.data : null
}

function compareSummary(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result.summary)) {
    throw new MobileWebBrokerError('host_error')
  }
  return result.summary
}

function branchCompareStatus(
  value: unknown
): 'ready' | 'invalid-base' | 'unborn-head' | 'no-merge-base' | 'error' {
  return value === 'ready' ||
    value === 'invalid-base' ||
    value === 'unborn-head' ||
    value === 'no-merge-base'
    ? value
    : 'error'
}

function commitCompareStatus(value: unknown): 'ready' | 'invalid-commit' | 'error' {
  return value === 'ready' || value === 'invalid-commit' ? value : 'error'
}

function safeGitRef(value: unknown): string | null {
  const parsed = MobileWebGitRefNameSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function safeObjectId(value: unknown): string | null {
  const parsed = MobileWebGitObjectIdSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function safeNonnegativeInteger(value: unknown): number {
  return optionalNonnegativeInteger(value) ?? 0
}

function optionalNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
