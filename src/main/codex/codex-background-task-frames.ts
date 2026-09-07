// Reading the strip's inputs off the Codex app-server wire.
//
// Verified against a live `codex app-server` 0.153.4 probe, not inferred from
// the rollout JSONL dialect (which is snake_case and carries different keys):
//   * `item/started` / `item/completed` envelopes are
//     `{item, threadId, turnId, startedAtMs|completedAtMs}`. The `turnId` on a
//     `subAgentActivity` envelope is the PARENT turn that spawned the child,
//     not a turn of the child's own thread.
//   * `commandExecution` carries `{command, commandActions, cwd, status,
//     exitCode, processId, source, ...}` — `commandActions`, never `parsedCmd`.
//     `status` is `inProgress | completed | failed | declined`.
//   * A child's own shell calls arrive with `threadId` set to the CHILD thread,
//     so a primary-thread filter is what separates the session's own commands
//     from a subagent's.

import { isTerminalSubagentState } from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import {
  codexSubagentLabel,
  codexSubagentStateForKind,
  isCodexRootAgentActivity,
  readCodexSubagentActivity
} from './codex-subagent-activity'
import { readRecord, readString } from './codex-item-field-readers'
import { readCodexThreadItem } from './codex-structured-item-translation'
import { readCodexTurnId } from './codex-structured-thread-facts'

export const CODEX_COMMAND_ITEM_TYPE = 'commandExecution'

export type CodexBackgroundTaskFrame =
  | {
      kind: 'subagent'
      agentThreadId: string
      label: string | null
      state: NativeChatSubagentState
      /** The parent turn the child was spawned in; null when Codex named none. */
      turnId: string | null
    }
  | {
      kind: 'command'
      itemId: string
      label: string | null
      running: boolean
      turnId: string | null
    }
  | { kind: 'turn-completed'; turnId: string }

export type CodexBackgroundTaskEvent = {
  method: string
  threadId: string
  params: unknown
}

/** The shell text worth showing on one truncated row. Codex wraps every agent
 *  call as `/bin/zsh -lc '<real command>'`, so its own single-action parse is
 *  the shorter true name; a compound command parses to several actions and
 *  keeps the wrapper rather than being named after one of its halves. */
function commandLabel(item: Record<string, unknown>): string | null {
  const actions = item.commandActions
  if (Array.isArray(actions) && actions.length === 1) {
    const parsed = readString(readRecord(actions[0]), 'command')
    if (parsed !== null) {
      return parsed
    }
  }
  return readString(item, 'command')
}

/** Codex reports `inProgress` until a terminal status; an item that names no
 *  status at all is still in flight, which is how `item/started` arrives on
 *  builds that omit it. */
function commandRunning(item: Record<string, unknown>): boolean {
  const status = readString(item, 'status')
  return status === null || status === 'inProgress'
}

/**
 * The strip-relevant fact in one notification, or null when it carries none.
 *
 * `primaryThreadId` is the session's own thread. Command frames are read only
 * from it: a child's shell calls belong to the child, which the roster already
 * reports as one `agent` row, and counting both would inflate a single fan-out.
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
  if (!item) {
    return null
  }
  const turnId = readCodexTurnId(event.params)
  const activity = readCodexSubagentActivity(item)
  if (activity) {
    // The root node is the parent turn reporting itself, not a child it spawned.
    if (isCodexRootAgentActivity(activity)) {
      return null
    }
    return {
      kind: 'subagent',
      agentThreadId: activity.agentThreadId,
      label: codexSubagentLabel(activity),
      state: codexSubagentStateForKind(activity.kind),
      turnId
    }
  }
  if (item.type !== CODEX_COMMAND_ITEM_TYPE || event.threadId !== primaryThreadId) {
    return null
  }
  return {
    kind: 'command',
    itemId: item.id,
    label: commandLabel(item),
    running: commandRunning(item),
    turnId
  }
}

/** Re-exported so the tracker and the durable roster share one terminal test:
 *  a child that reads settled on one surface must read settled on the other. */
export { isTerminalSubagentState }
