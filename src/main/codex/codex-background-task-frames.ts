// Reading the strip's inputs off the Codex app-server wire.
//
// Verified against a live `codex app-server` 0.153.4 probe, not inferred from
// the rollout JSONL dialect (which is snake_case and carries different keys):
//   * `item/started` / `item/completed` envelopes are
//     `{item, threadId, turnId, startedAtMs|completedAtMs}`. The `turnId` on a
//     `subAgentActivity` envelope is the PARENT turn that spawned the child,
//     not a turn of the child's own thread.
//   * `subAgentActivity` is `{type, id, kind, agentThreadId, agentPath}`, and
//     each transition arrives TWICE — via `item/started` and `item/completed`.
//   * `collabAgentToolCall` arrived with `receiverThreadIds: []` AND
//     `agentsStates: {}` on every frame, and no `spawnAgent` item was emitted at
//     all, so it says nothing about which children exist and is not read here.
//
// ONLY subagents. A `commandExecution` still `inProgress` when its turn ends is
// deliberately NOT a task: `settleCodexJournalTurn` already writes every such
// item to the journal as `state: 'failed'` on `turn/completed` and forgets it.
// A strip row claiming that same shell is still running would contradict the
// row Orca just wrote about it. A subagent is the opposite case — the roster
// pointedly does not sweep at a turn boundary, because children outlive it.

import { isTerminalSubagentState } from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import {
  codexSubagentLabel,
  codexSubagentStateForKind,
  isCodexRootAgentActivity,
  readCodexSubagentActivity
} from './codex-subagent-activity'
import { readRecord } from './codex-item-field-readers'
import { readCodexThreadItem } from './codex-structured-item-translation'
import { readCodexTurnId } from './codex-structured-thread-facts'

export type CodexBackgroundTaskFrame =
  | {
      kind: 'subagent'
      agentThreadId: string
      label: string | null
      state: NativeChatSubagentState
      /** The parent turn the child was spawned in; null when Codex named none. */
      turnId: string | null
    }
  | { kind: 'turn-completed'; turnId: string }

export type CodexBackgroundTaskEvent = {
  method: string
  threadId: string
  params: unknown
}

/**
 * The strip-relevant fact in one notification, or null when it carries none.
 *
 * `primaryThreadId` is the session's own thread. Only its turns count as turn
 * boundaries here: a child completing a turn of its own is not the parent turn
 * ending, and treating it as one would reveal — or worse, settle — the wrong
 * group of children.
 */
export function readCodexBackgroundTaskFrame(
  event: CodexBackgroundTaskEvent,
  primaryThreadId: string
): CodexBackgroundTaskFrame | null {
  if (event.method === 'turn/completed') {
    if (event.threadId !== primaryThreadId) {
      return null
    }
    const turnId = readCodexTurnId(event.params)
    return turnId === null ? null : { kind: 'turn-completed', turnId }
  }
  if (event.method !== 'item/started' && event.method !== 'item/completed') {
    return null
  }
  const item = readCodexThreadItem(readRecord(event.params).item)
  const activity = item && readCodexSubagentActivity(item)
  // The root node is the parent turn reporting itself, not a child it spawned.
  if (!activity || isCodexRootAgentActivity(activity)) {
    return null
  }
  return {
    kind: 'subagent',
    agentThreadId: activity.agentThreadId,
    label: codexSubagentLabel(activity),
    state: codexSubagentStateForKind(activity.kind),
    turnId: readCodexTurnId(event.params)
  }
}

/** Re-exported so the tracker and the durable roster share one terminal test:
 *  a child that reads settled on one surface must read settled on the other. */
export { isTerminalSubagentState }
