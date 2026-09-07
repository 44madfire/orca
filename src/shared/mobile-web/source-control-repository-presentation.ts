import { MobileWebGitRefNameSchema } from './source-control-history-contract'
import {
  MobileWebSourceControlRepositoryStateSchema,
  MobileWebSourceControlUpstreamSnapshotSchema,
  type MobileWebSourceControlRepositoryState,
  type MobileWebSourceControlUpstreamSnapshot
} from './source-control-sync-contract'
import { MobileWebBrokerError } from './bridge-operation-error'

export function projectMobileWebRepositoryState(args: {
  status: unknown
  upstream: unknown
  baseRef: unknown
  workspaceId: string
}): MobileWebSourceControlRepositoryState {
  if (!isRecord(args.status)) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebSourceControlRepositoryStateSchema.parse({
    workspaceId: args.workspaceId,
    head: safeHead(args.status.head),
    branch: safeBranch(args.status.branch),
    conflictOperation: safeConflictOperation(args.status.conflictOperation),
    baseRef: safeBranch(args.baseRef),
    upstream: projectMobileWebUpstreamSnapshot(args.upstream)
  })
}

export function projectMobileWebUpstreamSnapshot(
  value: unknown
): MobileWebSourceControlUpstreamSnapshot {
  if (!isRecord(value)) {
    throw new MobileWebBrokerError('host_error')
  }
  const upstreamName = boundedString(value.upstreamName, 240)
  return MobileWebSourceControlUpstreamSnapshotSchema.parse({
    hasUpstream: value.hasUpstream === true,
    ...(upstreamName ? { upstreamName } : {}),
    ahead: safeNonnegativeInteger(value.ahead),
    behind: safeNonnegativeInteger(value.behind),
    hasConfiguredPushTarget: value.hasConfiguredPushTarget === true,
    behindCommitsArePatchEquivalent: value.behindCommitsArePatchEquivalent === true
  })
}

function safeHead(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) ? value : null
}

function safeBranch(value: unknown): string | null {
  const parsed = MobileWebGitRefNameSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function safeConflictOperation(value: unknown): 'merge' | 'rebase' | 'cherry-pick' | 'unknown' {
  return value === 'merge' || value === 'rebase' || value === 'cherry-pick' ? value : 'unknown'
}

function safeNonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, limit)
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
