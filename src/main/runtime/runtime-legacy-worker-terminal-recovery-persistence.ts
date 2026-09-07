import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'
import type { OrchestrationDb } from './orchestration/db'
import {
  planLegacyWorkerTerminalRecovery,
  type LegacyWorkerTerminalRecoveryPlan
} from './orchestration/orchestration-legacy-worker-terminal-recovery'
import type { RuntimeStore } from './runtime-store-contract'
import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryResolution
} from './runtime-legacy-worker-terminal-recovery-types'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from './workspace-session-failed-write-rollback'

export class RuntimeLegacyWorkerTerminalRecoveryPersistence {
  constructor(
    private readonly getStore: () => RuntimeStore | null,
    private readonly getDb: () => OrchestrationDb,
    private readonly getHostId: (worktreeId: string) => ExecutionHostId | null,
    /** Invalidation only. The state itself lives in the session field; a push that carried it is
     *  what made the fence lossy across renderer reloads. */
    private readonly notifyFenceChanged?: () => void
  ) {}

  /**
   * Writes the whole fenced-pane set for every host on every pass. Level-triggered on purpose:
   * there is no edge to miss, nothing to announce once, and no bookkeeping to keep in step with
   * the store, so a renderer that reloads simply reads the field again.
   *
   * `legacyWorkerResumeFencesByPaneKey` is runtime-authored and absent from the renderer's patch
   * builder, so this write is the only author and a renderer session write cannot erase it.
   */
  prepare(): LegacyWorkerTerminalRecoveryPlan {
    const plan = this.getPlan()
    if (!plan) {
      // An unreadable plan is not evidence that any pane stopped needing its fence: write nothing
      // and retry on the next pass, leaving the previously written set in place.
      return { blockedPanes: [], candidates: [], ambiguousDispatchIds: [] }
    }
    const store = this.getStore()
    if (!store?.getWorkspaceSession || !store.setWorkspaceSession) {
      return plan
    }
    const hostIds = store.getWorkspaceSessionHostIds?.() ?? [LOCAL_EXECUTION_HOST_ID]
    // Why seeded from the listed hosts: a host that no longer owns any fenced pane still has to be
    // written with an empty set, or its last set would stay pinned forever.
    const fencedByHost = new Map<ExecutionHostId, Record<string, true>>(
      hostIds.map((hostId) => [hostId, {}])
    )
    for (const blocked of plan.blockedPanes) {
      let owners: ExecutionHostId[]
      try {
        const hostId = this.getHostId(blocked.worktreeId)
        if (!hostId) {
          throw new Error('folder_workspace_not_found')
        }
        owners = [hostId]
      } catch (error) {
        // An owner this store cannot name is written to whichever partition already retains this
        // pane, and to every host only when none does. Losing the fence relaunches a worker that
        // is still running, so the fallback widens rather than skipping.
        console.warn('[orchestration] legacy worker resume fence owner is unavailable', {
          worktreeId: blocked.worktreeId,
          error
        })
        const retaining = hostIds.filter((hostId) => {
          const session = store.getWorkspaceSession?.(hostId)
          return (
            session?.sleepingAgentSessionsByPaneKey?.[blocked.paneKey] !== undefined ||
            session?.legacyWorkerResumeFencesByPaneKey?.[blocked.paneKey] === true
          )
        })
        owners = retaining.length > 0 ? retaining : hostIds
      }
      for (const hostId of owners) {
        // An owner outside the listed hosts still gets its own entry; the list is a floor.
        const fenced = fencedByHost.get(hostId) ?? {}
        fenced[blocked.paneKey] = true
        fencedByHost.set(hostId, fenced)
      }
    }
    let changed = false
    try {
      for (const [hostId, fenced] of fencedByHost) {
        const current = store.getWorkspaceSession(hostId)
        if (!current || sameFenceSet(current.legacyWorkerResumeFencesByPaneKey, fenced)) {
          continue
        }
        store.setWorkspaceSession({ ...current, legacyWorkerResumeFencesByPaneKey: fenced }, hostId)
        changed = true
      }
    } catch (error) {
      // A failed write publishes nothing, and the next pass rewrites the same level.
      console.warn('[orchestration] failed to write legacy worker resume fences', error)
      return plan
    }
    if (changed) {
      this.notifyFenceChanged?.()
    }
    return plan
  }

  async persist(
    resolutions: readonly LegacyWorkerRecoveryResolution[]
  ): Promise<ReadonlySet<string>> {
    const store = this.getStore()
    if (
      !store?.getWorkspaceSession ||
      !store.setWorkspaceSession ||
      (!store.flushPendingOrThrowAsync && !store.flushOrThrow)
    ) {
      return new Set()
    }
    const originals = new Map<ExecutionHostId, WorkspaceSessionState>()
    const staged = new Map<ExecutionHostId, WorkspaceSessionState>()
    const dispatchIds = new Set<string>()
    try {
      for (const { candidate, resolution } of resolutions) {
        const hostId = this.getHostId(candidate.worktreeId)
        const session = hostId ? store.getWorkspaceSession(hostId) : null
        if (!hostId || !session) {
          continue
        }
        originals.set(hostId, originals.get(hostId) ?? session)
        let next =
          resolution === 'exited'
            ? retireTerminalSurfaceFromPersistence(session, {
                worktreeId: candidate.worktreeId,
                parentTabId: candidate.tabId,
                leafId: candidate.leafId,
                ptyId: candidate.ptyId,
                incarnationId: candidate.incarnationId
              })
            : session
        const record = next.sleepingAgentSessionsByPaneKey?.[candidate.paneKey]
        if (record && runtimeWorktreeIdsEqual(record.worktreeId, candidate.worktreeId)) {
          const sleeping = { ...next.sleepingAgentSessionsByPaneKey }
          delete sleeping[candidate.paneKey]
          next = { ...next, sleepingAgentSessionsByPaneKey: sleeping }
        }
        if (next !== session) {
          store.setWorkspaceSession(next, hostId)
        }
        staged.set(hostId, store.getWorkspaceSession(hostId))
        dispatchIds.add(candidate.dispatchId)
      }
      if (dispatchIds.size > 0) {
        await this.flush(store)
      }
      return dispatchIds
    } catch (error) {
      for (const [hostId, original] of originals) {
        const stagedSession = staged.get(hostId)
        const current = store.getWorkspaceSession(hostId)
        if (!stagedSession || !current) {
          continue
        }
        const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(
          original,
          stagedSession,
          current
        )
        if (rolledBack !== current) {
          store.setWorkspaceSession(rolledBack, hostId)
        }
      }
      console.warn('[orchestration] failed to persist legacy worker recovery batch', {
        dispatchIds: [...dispatchIds],
        error
      })
      return new Set()
    }
  }

  reconcileMissing(candidate: LegacyWorkerRecoveryCandidate): boolean {
    if (candidate.dispatchStatus !== 'pending' && candidate.dispatchStatus !== 'dispatched') {
      return true
    }
    try {
      this.getDb().reconcileMissingWorkerTerminal(
        candidate.dispatchId,
        'The assigned worker terminal is no longer live after orchestration recovery.'
      )
      return true
    } catch (error) {
      console.warn('[orchestration] failed to reconcile missing worker terminal', {
        dispatchId: candidate.dispatchId,
        error
      })
      return false
    }
  }

  private getPlan(): LegacyWorkerTerminalRecoveryPlan | null {
    try {
      return planLegacyWorkerTerminalRecovery(this.getDb().listLegacyWorkerTerminalRecoveryRows())
    } catch (error) {
      console.warn('[orchestration] failed to plan legacy worker terminal recovery', error)
      return null
    }
  }

  private async flush(store: RuntimeStore): Promise<void> {
    if (store.flushPendingOrThrowAsync) {
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      return
    }
    if (store.flushOrThrow) {
      store.flushOrThrow()
      return
    }
    throw new Error('workspace_session_persistence_unavailable')
  }
}

/** Identity is not enough: `prepare` rebuilds the set every pass, so compare by content or every
 *  pass would rewrite the session and wake every session subscriber. */
function sameFenceSet(
  current: Record<string, true> | undefined,
  next: Record<string, true>
): boolean {
  const currentKeys = Object.keys(current ?? {})
  const nextKeys = Object.keys(next)
  return (
    currentKeys.length === nextKeys.length &&
    nextKeys.every((paneKey) => current?.[paneKey] === true)
  )
}
