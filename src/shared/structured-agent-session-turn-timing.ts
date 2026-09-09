// Turn timing read straight off durable lifecycle items. The execution host
// stamps both endpoints on its own clock, so a completed value is the same on
// every client and needs no local clock. Shared by desktop and mobile.

import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycleState
} from './agent-session-journal-types'
import type { NativeChatSettledTurn } from './native-chat-turn-status'

export type StructuredAgentTurnTiming = {
  state: AgentJournalTurnLifecycleState
  /** Host clock at provider turn-start receipt. */
  startedAt: number
  /** Host clock at the terminal provider event; absent while running or unverifiable. */
  completedAt?: number
  /** Host clock when the lifecycle row was appended; with `startedAt` it gives
   *  the host-side lag a client must subtract to anchor a live counter. */
  observedAt: number
}

function readTiming(item: AgentJournalRenderItem): StructuredAgentTurnTiming | null {
  const body = item.body
  if (body.kind !== 'status' || !body.turnLifecycle) {
    return null
  }
  const { state, startedAt, completedAt } = body.turnLifecycle
  if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt <= 0) {
    return null
  }
  const end =
    completedAt !== undefined && Number.isFinite(completedAt) && completedAt >= startedAt
      ? completedAt
      : undefined
  return {
    state,
    startedAt,
    ...(end !== undefined ? { completedAt: end } : {}),
    observedAt: item.observedAt
  }
}

/** Timing keyed by the user message that opened each turn. A lifecycle row
 *  belongs to the nearest user message before it in journal order — the
 *  submission row is written ahead of dispatch, so it always precedes the
 *  provider's turn-start, and a prompt Codex folds into an already-running turn
 *  correctly claims no timing of its own. Lifecycle rows without `startedAt`
 *  (older hosts, conversation commands) are skipped. */
export function selectStructuredAgentTurnTimings(
  items: readonly AgentJournalRenderItem[]
): ReadonlyMap<string, StructuredAgentTurnTiming> {
  const timings = new Map<string, StructuredAgentTurnTiming>()
  let userItemId: string | null = null
  for (const item of items) {
    if (item.body.kind === 'message' && item.body.role === 'user') {
      userItemId = item.itemId
      continue
    }
    const timing = readTiming(item)
    if (timing && userItemId !== null) {
      timings.set(userItemId, timing)
    }
  }
  return timings
}

/** The live turn's lifecycle timing, or null when its row carries no host start
 *  (an older host), in which case a surface falls back to local observation. */
export function selectStructuredAgentRunningTurnTiming(
  items: readonly AgentJournalRenderItem[],
  turnId: string
): StructuredAgentTurnTiming | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.body.kind === 'status' && item.body.turnLifecycle?.turnId === turnId) {
      return readTiming(item)
    }
  }
  return null
}

/** Whole seconds a settled turn ran, or null when the host never observed its end. */
export function completedStructuredAgentTurnSeconds(
  timing: StructuredAgentTurnTiming | undefined
): number | null {
  return timing &&
    (timing.state === 'completed' || timing.state === 'interrupted') &&
    timing.completedAt !== undefined
    ? Math.floor((timing.completedAt - timing.startedAt) / 1000)
    : null
}

/** A local-clock anchor for the live counter that carries no host/client skew:
 *  the client's first sighting of the running row, moved back by the host-side
 *  lag between turn-start receipt and the row's append. Both terms are single-clock. */
export function structuredAgentTurnLocalStartedAt(
  timing: StructuredAgentTurnTiming,
  firstSeenAt: number
): number {
  return firstSeenAt - Math.max(0, timing.observedAt - timing.startedAt)
}

/** The settled turns a chat surface hands to the shared turn-status selector. */
export function selectStructuredAgentSettledTurns(
  items: readonly AgentJournalRenderItem[]
): ReadonlyMap<string, NativeChatSettledTurn> {
  const settled = new Map<string, NativeChatSettledTurn>()
  for (const [userItemId, timing] of selectStructuredAgentTurnTimings(items)) {
    const workedSeconds = completedStructuredAgentTurnSeconds(timing)
    if (workedSeconds !== null) {
      settled.set(userItemId, { startedAt: timing.startedAt, workedSeconds })
    }
  }
  return settled
}
