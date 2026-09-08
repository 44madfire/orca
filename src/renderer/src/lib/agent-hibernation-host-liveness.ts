import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { hostScopeCoveredExecutionHost } from '../../../shared/runtime-listing-host-scope'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../shared/runtime-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { AppState } from '@/store/types'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from './worktree-runtime-owner'

const HOST_LIVENESS_TIMEOUT_MS = 10_000
const HOST_LIVENESS_LIMIT = 10_000

/**
 * Where a workspace's fresh PTY-liveness evidence comes from. Hibernation is destructive, so
 * every host-owned workspace needs host evidence before a pane is shut down — client-side
 * bookkeeping observes no process (docs/reference/ssh-execution-boundary.md).
 *
 * - `runtime-authoritative`: a paired runtime peer owns its own control plane and the whole PTY
 *   inventory for its worktrees, so its listing replaces the client's view.
 * - `ssh-confirming`: an SSH box is a dumb execution host driven by this client, so the client's
 *   own runtime holds the relay provider and its PTY bindings stay authoritative for the surface.
 *   The host listing only confirms which of those bindings are still alive.
 */
export type HostLivenessTarget =
  | { kind: 'runtime-authoritative'; runtimeEnvironmentId: string }
  | { kind: 'ssh-confirming'; executionHostId: ExecutionHostId }

export type HostLivenessSample = {
  runtimeLivePtyIdsByWorktreeId: Record<string, string[]>
  runtimeLivenessRequiredWorktreeIds: string[]
  hostConfirmedLivenessWorktreeIds: string[]
}

export function getHostLivenessTarget(
  state: AppState,
  worktreeId: string
): HostLivenessTarget | null {
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (runtimeEnvironmentId) {
    return { kind: 'runtime-authoritative', runtimeEnvironmentId }
  }
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  return parseExecutionHostId(executionHostId)?.kind === 'ssh'
    ? { kind: 'ssh-confirming', executionHostId }
    : null
}

export function getHostLivenessTargetWorktrees(
  state: AppState,
  targetWorktreeId?: string
): Map<string, HostLivenessTarget> {
  const targets = new Map<string, HostLivenessTarget>()
  const worktreeIds = targetWorktreeId
    ? Object.hasOwn(state.tabsByWorktree, targetWorktreeId)
      ? [targetWorktreeId]
      : []
    : Object.keys(state.tabsByWorktree)
  for (const worktreeId of worktreeIds) {
    const target = getHostLivenessTarget(state, worktreeId)
    if (target) {
      targets.set(worktreeId, target)
    }
  }
  return targets
}

function getTypedRuntimePtyId(terminal: RuntimeTerminalSummary): string | null {
  if (terminal.ptyId) {
    return terminal.ptyId
  }
  if (terminal.tabId.startsWith('pty:') && terminal.tabId === terminal.leafId) {
    return terminal.tabId.slice('pty:'.length) || null
  }
  return null
}

/** Live PTY ids the owning host itself reported, or null when it produced no usable evidence. */
async function readHostLivePtyIds(
  worktreeId: string,
  target: HostLivenessTarget
): Promise<string[] | null> {
  const result = await callRuntimeRpc<RuntimeTerminalListResult>(
    // Why: an SSH box has no runtime RPC endpoint of its own. Its relay provider is registered in
    // THIS client's runtime, so the client's own runtime is the route to the execution host — not
    // a substitute for it. A paired runtime answers for itself.
    target.kind === 'runtime-authoritative'
      ? { kind: 'environment', environmentId: target.runtimeEnvironmentId }
      : { kind: 'local' },
    'terminal.list',
    {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      limit: HOST_LIVENESS_LIMIT,
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    },
    { timeoutMs: HOST_LIVENESS_TIMEOUT_MS }
  )
  if (result.truncated) {
    return null
  }
  // A listing that did not cover the workspace's own host is not evidence about it: the client's
  // runtime can answer for its local PTYs while the relay to the SSH box never replied.
  if (
    target.kind === 'ssh-confirming' &&
    !hostScopeCoveredExecutionHost(result.hostScope, target.executionHostId)
  ) {
    return null
  }
  const ptyIds = new Set<string>()
  for (const terminal of result.terminals) {
    if (!terminal.connected || terminal.worktreeId !== worktreeId) {
      continue
    }
    const ptyId = getTypedRuntimePtyId(terminal)
    if (ptyId) {
      ptyIds.add(ptyId)
    }
  }
  return [...ptyIds].sort()
}

export async function collectHostPtyLiveness(
  state: AppState,
  targetWorktreeId?: string
): Promise<HostLivenessSample> {
  const targets = getHostLivenessTargetWorktrees(state, targetWorktreeId)
  const runtimeLivePtyIdsByWorktreeId: Record<string, string[]> = {}
  await Promise.all(
    [...targets].map(async ([worktreeId, target]) => {
      try {
        const ptyIds = await readHostLivePtyIds(worktreeId, target)
        if (ptyIds) {
          runtimeLivePtyIdsByWorktreeId[worktreeId] = ptyIds
        }
      } catch {
        // Why: stale host liveness is unsafe for all-or-nothing hibernation; omitting the
        // worktree makes the planner fail closed for this pass. Loss of contact is never
        // evidence that a host-owned PTY exited.
      }
    })
  )
  return {
    runtimeLivePtyIdsByWorktreeId,
    runtimeLivenessRequiredWorktreeIds: [...targets.keys()],
    hostConfirmedLivenessWorktreeIds: [...targets]
      .filter(([, target]) => target.kind === 'ssh-confirming')
      .map(([worktreeId]) => worktreeId)
  }
}
