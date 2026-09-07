import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AppState } from '../types'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import { collectSleepingAgentSessionRecordsForWorktree } from './agent-status-recovery-collection'
import {
  removeSleepingRecordsReplacedByManualWorktreeSleep,
  sleepingRecordFromEntry
} from './agent-status-sleeping-records'
import {
  recoveryRecordTargetsSameSession,
  sleepingRecordsEquivalentIgnoringCaptureTime
} from './agent-status-recovery-equivalence'
import { getLaunchConfigForEntry } from './agent-status-launch-config'
import { findAgentPaneWorktreeId } from './agent-status-pane-key-tab-binding'
import { isCompletedPiCompatibleAgentWithLiveRecoveryRecord } from '@/lib/live-resume-anchor-record'

/** The single writer for the resume fence's two homes. The pane-key map is tracked even with no
 *  record, because a worker settled while its tab was open is fenced before the record is minted;
 *  the record is the durable home and must move with it. `generation` is main's commit counter, so
 *  a startup reply that lost a race with a later lift cannot walk the newer state backwards. */
function applyFenceToPanes(
  state: AppState,
  changes: ReadonlyMap<string, boolean>,
  generation: number | undefined
): Partial<AppState> | AppState {
  let paneKeys = state.automaticResumeBlockedPaneKeys
  let records = state.sleepingAgentSessionsByPaneKey
  for (const [paneKey, blocked] of changes) {
    if ((paneKeys[paneKey] === true) !== blocked) {
      if (paneKeys === state.automaticResumeBlockedPaneKeys) {
        paneKeys = { ...paneKeys }
      }
      if (blocked) {
        paneKeys[paneKey] = true
      } else {
        delete paneKeys[paneKey]
      }
    }
    const current = records[paneKey]
    const recordBlocked = current?.automaticResumeBlockedBy === 'legacy-orchestration-worker'
    if (!current || recordBlocked === blocked) {
      continue
    }
    const next = { ...current }
    if (blocked) {
      next.automaticResumeBlockedBy = 'legacy-orchestration-worker'
    } else {
      delete next.automaticResumeBlockedBy
    }
    if (records === state.sleepingAgentSessionsByPaneKey) {
      records = { ...records }
    }
    records[paneKey] = next
  }
  const nextGeneration = Math.max(state.automaticResumeFenceGeneration, generation ?? 0)
  if (
    paneKeys === state.automaticResumeBlockedPaneKeys &&
    records === state.sleepingAgentSessionsByPaneKey &&
    nextGeneration === state.automaticResumeFenceGeneration
  ) {
    return state
  }
  return {
    automaticResumeBlockedPaneKeys: paneKeys,
    sleepingAgentSessionsByPaneKey: records,
    automaticResumeFenceGeneration: nextGeneration
  }
}

export function createAgentStatusRecoveryActions(
  runtime: AgentStatusRuntime
): Pick<
  AgentStatusSlice,
  | 'captureSleepingAgentSessionsByWorktree'
  | 'captureAllSleepingAgentSessions'
  | 'clearSleepingAgentSession'
  | 'clearSleepingAgentSessionsByPaneKey'
  | 'setSleepingAgentAutomaticResumeBlocked'
  | 'applyLegacyWorkerResumeFenceSnapshot'
  | 'clearSleepingAgentSessionsByWorktree'
  | 'pruneSleepingAgentSessions'
> {
  const { set, clearSleepingAgentSessionsByPaneKey } = runtime
  return {
    captureSleepingAgentSessionsByWorktree: (worktreeId, paneKeys) => {
      set((s) => {
        const records = collectSleepingAgentSessionRecordsForWorktree(s, worktreeId, {
          paneKeys,
          captureMode: 'manual-worktree-sleep'
        })
        const replaced = removeSleepingRecordsReplacedByManualWorktreeSleep(
          s.sleepingAgentSessionsByPaneKey,
          worktreeId,
          paneKeys,
          records
        )
        let next = { ...replaced.records }
        let changed = replaced.changed
        for (const record of Object.values(records)) {
          if (next[record.paneKey] !== record) {
            next[record.paneKey] = record
            changed = true
          }
        }
        return changed ? { sleepingAgentSessionsByPaneKey: next } : s
      })
    },

    captureAllSleepingAgentSessions: (mode) => {
      set((s) => {
        const capturedAt = Date.now()
        const origin = mode === 'quit' ? ('quit' as const) : ('live' as const)
        const next: Record<string, SleepingAgentSessionRecord> = {
          ...s.sleepingAgentSessionsByPaneKey
        }
        let changed = false
        for (const entry of Object.values(s.agentStatusByPaneKey)) {
          if (entry.state === 'done') {
            const existing = next[entry.paneKey]
            if (
              !isCompletedPiCompatibleAgentWithLiveRecoveryRecord(entry, existing) ||
              mode === 'periodic'
            ) {
              continue
            }
            const record = { ...existing, capturedAt, origin }
            if (!sleepingRecordsEquivalentIgnoringCaptureTime(existing, record)) {
              next[entry.paneKey] = record
              changed = true
            }
            continue
          }
          const worktreeId = entry.worktreeId ?? findAgentPaneWorktreeId(s, entry.paneKey)
          if (!worktreeId) {
            continue
          }
          const record = sleepingRecordFromEntry({
            state: s,
            entry,
            worktreeId,
            capturedAt,
            launchConfig: getLaunchConfigForEntry(s, entry),
            origin
          })
          const existing = next[entry.paneKey]
          if (
            mode === 'periodic' &&
            existing?.origin === 'quit' &&
            record &&
            recoveryRecordTargetsSameSession(existing, record)
          ) {
            continue
          }
          if (record && !sleepingRecordsEquivalentIgnoringCaptureTime(existing, record)) {
            next[record.paneKey] = record
            changed = true
          }
        }
        return changed ? { sleepingAgentSessionsByPaneKey: next } : s
      })
    },

    clearSleepingAgentSession: (paneKey) => clearSleepingAgentSessionsByPaneKey([paneKey]),
    clearSleepingAgentSessionsByPaneKey,

    setSleepingAgentAutomaticResumeBlocked: (paneKey, blocked, generation) => {
      set((s) => applyFenceToPanes(s, new Map([[paneKey, blocked]]), generation))
    },

    // Why replace rather than merge: main hands over its whole committed fence state, so a pane it
    // no longer claims is retired. An unreadable plan does not reach this — a pass that commits
    // nothing leaves the previous committed state and generation in place.
    applyLegacyWorkerResumeFenceSnapshot: (snapshot) => {
      set((s) => {
        if (snapshot.generation < s.automaticResumeFenceGeneration) {
          return s
        }
        const blockedPaneKeys = new Set(snapshot.blockedPaneKeys)
        const changes = new Map<string, boolean>()
        for (const paneKey of blockedPaneKeys) {
          changes.set(paneKey, true)
        }
        for (const paneKey of Object.keys(s.automaticResumeBlockedPaneKeys)) {
          if (!blockedPaneKeys.has(paneKey)) {
            changes.set(paneKey, false)
          }
        }
        return applyFenceToPanes(s, changes, snapshot.generation)
      })
    },

    clearSleepingAgentSessionsByWorktree: (worktreeId) => {
      set((s) => {
        let changed = false
        const next: Record<string, SleepingAgentSessionRecord> = {}
        const removed: string[] = []
        for (const [paneKey, record] of Object.entries(s.sleepingAgentSessionsByPaneKey)) {
          if (record.worktreeId === worktreeId) {
            changed = true
            removed.push(paneKey)
          } else {
            next[paneKey] = record
          }
        }
        if (!changed) {
          return s
        }
        const nextLaunch =
          removed.length > 0 ? { ...s.agentLaunchConfigByPaneKey } : s.agentLaunchConfigByPaneKey
        for (const paneKey of removed) {
          delete nextLaunch[paneKey]
        }
        return {
          sleepingAgentSessionsByPaneKey: next,
          ...(nextLaunch !== s.agentLaunchConfigByPaneKey
            ? { agentLaunchConfigByPaneKey: nextLaunch }
            : {})
        }
      })
    },

    pruneSleepingAgentSessions: (validWorktreeIds) => {
      set((s) => {
        let changed = false
        const next: Record<string, SleepingAgentSessionRecord> = {}
        const removed: string[] = []
        for (const [paneKey, record] of Object.entries(s.sleepingAgentSessionsByPaneKey)) {
          if (!validWorktreeIds.has(record.worktreeId)) {
            changed = true
            removed.push(paneKey)
          } else {
            next[paneKey] = record
          }
        }
        if (!changed) {
          return s
        }
        const nextLaunch =
          removed.length > 0 ? { ...s.agentLaunchConfigByPaneKey } : s.agentLaunchConfigByPaneKey
        for (const paneKey of removed) {
          delete nextLaunch[paneKey]
        }
        return {
          sleepingAgentSessionsByPaneKey: next,
          ...(nextLaunch !== s.agentLaunchConfigByPaneKey
            ? { agentLaunchConfigByPaneKey: nextLaunch }
            : {})
        }
      })
    }
  }
}
