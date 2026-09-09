import { useMemo, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatSettledTurn } from '../../../../shared/native-chat-turn-status'
import {
  selectStructuredAgentRunningTurnTiming,
  selectStructuredAgentSettledTurns,
  structuredAgentTurnLocalStartedAt
} from '../../../../shared/structured-agent-session-turn-timing'

type TurnAnchor = { turnId: string; startedAt: number | null }

/** The live turn's local-clock anchor. Null when its row carries no host start
 *  (older hosts), so local observation applies. */
function anchorRunningTurn(items: readonly AgentJournalRenderItem[], turnId: string): TurnAnchor {
  const timing = selectStructuredAgentRunningTurnTiming(items, turnId)
  return {
    turnId,
    startedAt: timing ? structuredAgentTurnLocalStartedAt(timing, Date.now()) : null
  }
}

/** Host-recorded turn timing for the structured lane: settled durations straight
 *  off the journal, and a skew-free start for the live counter stamped once per
 *  turn so re-renders never move it. */
export function useStructuredAgentTurnTiming(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  turnId: string | null
): { settledTurns: ReadonlyMap<string, NativeChatSettledTurn>; workingStartedAt: number | null } {
  const settledTurns = useMemo(
    () => selectStructuredAgentSettledTurns(items, submissions),
    [items, submissions]
  )
  const [anchor, setAnchor] = useState<TurnAnchor | null>(null)
  // Stamp during render (React's derive-from-props pattern) so the first paint of
  // a new turn already counts from the right instant.
  if (turnId === null) {
    if (anchor !== null) {
      setAnchor(null)
    }
    return { settledTurns, workingStartedAt: null }
  }
  if (anchor?.turnId !== turnId) {
    const next = anchorRunningTurn(items, turnId)
    setAnchor(next)
    return { settledTurns, workingStartedAt: next.startedAt }
  }
  return { settledTurns, workingStartedAt: anchor.startedAt }
}
