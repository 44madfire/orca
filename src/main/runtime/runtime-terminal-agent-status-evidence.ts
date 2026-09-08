import {
  isOpenCodeNativeTitle,
  isQuarterCircleSpinnerOnlyAgentTitle,
  type AgentStatus
} from '../../shared/agent-detection'
import type { RuntimeTerminalAgentStatusSnapshot } from './runtime-terminal-agent-status-query'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'

type StatusObservation = {
  status: AgentStatus | null
  updatedAt: number
  stateStartedAt?: number | null
}

export type TerminalAgentStatusEvidence = {
  source: 'explicit' | 'title' | 'wait-text' | 'none'
  status: AgentStatus | null
  updatedAt: number | null
  corroboration: 'shell' | 'agent' | 'none'
}

// All timestamps are execution-host receipt times, never provider wall clocks or revisions.
export function selectTerminalAgentStatusEvidence(
  terminal: RuntimeTerminalAgentStatusSnapshot,
  explicit: StatusObservation | null,
  lifecycle: StatusObservation | null | undefined
): TerminalAgentStatusEvidence {
  if (
    terminal.titleStatus === 'permission' &&
    terminal.titleStatusIsLive &&
    !explicitClearsObservation(explicit, terminal.titleUpdatedAt)
  ) {
    return {
      source: 'title',
      status: 'permission',
      updatedAt: terminal.titleUpdatedAt ?? null,
      corroboration: 'none'
    }
  }

  const waitEvidence = selectTerminalWaitPermissionEvidence(terminal, explicit, lifecycle)
  if (waitEvidence) {
    return { ...waitEvidence, status: 'permission', corroboration: 'none' }
  }
  if (explicit?.status) {
    return { source: 'explicit', ...explicit, corroboration: 'shell' }
  }
  if (terminal.titleStatus) {
    return {
      source: 'title',
      status: terminal.titleStatus,
      updatedAt: terminal.titleUpdatedAt ?? null,
      corroboration:
        isOpenCodeNativeTitle(terminal.title) ||
        isQuarterCircleSpinnerOnlyAgentTitle(terminal.title)
          ? 'agent'
          : 'none'
    }
  }
  return { source: 'none', status: null, updatedAt: null, corroboration: 'agent' }
}

export function selectTerminalWaitPermissionEvidence(
  terminal: RuntimeTerminalAgentStatusSnapshot,
  explicit: StatusObservation | null,
  lifecycle: StatusObservation | null | undefined
): {
  source: 'wait-text'
  reason: RuntimeTerminalWaitBlockedReason
  updatedAt: number | null
} | null {
  const blockedReason = detectTerminalWaitBlockedReason(terminal.waitText)
  const liveTitleClearsBlockedText =
    terminal.titleStatusIsLive &&
    terminal.titleStatus !== null &&
    terminal.titleStatus !== 'permission' &&
    !isOpenCodeNativeTitle(terminal.title) &&
    blockedReason !== 'agent-approval-prompt'
  const newestPermissionAt = Math.max(
    explicit?.status === 'permission' ? explicit.updatedAt : -1,
    lifecycle?.status === 'permission' ? lifecycle.updatedAt : -1,
    terminal.waitBlockedAt ?? -1
  )
  const newestClearAt = Math.max(
    explicit?.status && explicit.status !== 'permission' ? explicit.updatedAt : -1,
    lifecycle?.status && lifecycle.status !== 'permission' ? lifecycle.updatedAt : -1
  )
  if (
    blockedReason &&
    (!liveTitleClearsBlockedText || lifecycle?.status === terminal.titleStatus) &&
    (blockedReason === 'agent-approval-prompt'
      ? !explicitClearsObservation(explicit, terminal.waitBlockedAt)
      : newestPermissionAt >= 0 && newestPermissionAt >= newestClearAt)
  ) {
    return {
      source: 'wait-text',
      reason: blockedReason,
      updatedAt: terminal.waitBlockedAt
    }
  }
  return null
}

function explicitClearsObservation(
  explicit: StatusObservation | null,
  updatedAt: number | null | undefined
): boolean {
  return (
    explicit?.status != null &&
    explicit.status !== 'permission' &&
    updatedAt != null &&
    updatedAt > 0 &&
    explicit.stateStartedAt != null &&
    explicit.stateStartedAt > updatedAt
  )
}
