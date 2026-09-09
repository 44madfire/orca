import type { AgentHookSource } from '../agent-hook-relay'
import {
  agentDescendantEffectiveState,
  agentDescendantRosterToSnapshots,
  finishAgentDescendant,
  upsertAgentDescendant,
  type AgentDescendantRoster
} from '../agent-descendant-roster'
import { normalizeAgentStatusPayload, type ParsedAgentStatusPayload } from '../agent-status-types'
import type { DescendantEventFacts } from './descendant-events'
import type { HookListenerState } from './listener-state'

function getOrCreateDescendantRoster(
  state: HookListenerState,
  paneKey: string
): AgentDescendantRoster {
  let roster = state.descendantRosterByPaneKey.get(paneKey)
  if (!roster) {
    roster = new Map()
    state.descendantRosterByPaneKey.set(paneKey, roster)
  }
  return roster
}

/** Apply a descendant's lifecycle event: it updates the child list and republishes
 *  the pane from the LEAD's last known state, so a child finishing can never be the
 *  pane's completion. The lead's own tool/prompt caches are left untouched — a
 *  child's tool call is not the pane's, and overwriting them would relabel the row
 *  with the child's work. */
export function applyDescendantEventToPane(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  facts: DescendantEventFacts
): ParsedAgentStatusPayload | null {
  if (facts.id) {
    if (facts.ended) {
      const roster = state.descendantRosterByPaneKey.get(paneKey)
      if (roster) {
        finishAgentDescendant(roster, facts.id)
        if (roster.size === 0) {
          state.descendantRosterByPaneKey.delete(paneKey)
        }
      }
    } else {
      upsertAgentDescendant(
        getOrCreateDescendantRoster(state, paneKey),
        facts.id,
        {
          agentType: facts.agentType,
          description: facts.description,
          model: facts.model,
          state: 'working'
        },
        Date.now()
      )
    }
  }

  // Why: a child event before any lead event still proves the pane is working — the lead spawned it.
  const leadState = state.descendantLeadStateByPaneKey.get(paneKey) ?? 'working'
  const cachedTool = state.lastToolByPaneKey.get(paneKey) ?? {}
  return normalizeAgentStatusPayload({
    state: agentDescendantEffectiveState(state.descendantRosterByPaneKey.get(paneKey), leadState),
    prompt: state.lastPromptByPaneKey.get(paneKey) ?? '',
    agentType: source,
    toolName: cachedTool.toolName,
    toolInput: cachedTool.toolInput,
    interactivePrompt: cachedTool.interactivePrompt,
    lastAssistantMessage: cachedTool.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: cachedTool.lastAssistantMessageIsToolOutput,
    subagents: agentDescendantRosterToSnapshots(state.descendantRosterByPaneKey.get(paneKey))
  })
}

/** The pane is idle only when its lead session is idle AND no descendant is live.
 *  Records the lead's own verdict first, so draining the last descendant later
 *  republishes what the lead actually said instead of the gated value. */
export function gatePaneStateOnDescendants(
  state: HookListenerState,
  paneKey: string,
  payload: ParsedAgentStatusPayload | null
): ParsedAgentStatusPayload | null {
  if (!payload) {
    return payload
  }
  state.descendantLeadStateByPaneKey.set(paneKey, payload.state)
  const roster = state.descendantRosterByPaneKey.get(paneKey)
  if (!roster || roster.size === 0) {
    return payload
  }
  return {
    ...payload,
    state: agentDescendantEffectiveState(roster, payload.state),
    subagents: agentDescendantRosterToSnapshots(roster)
  }
}

export function clearDescendantScope(state: HookListenerState, paneKey: string): void {
  state.descendantRosterByPaneKey.delete(paneKey)
  state.descendantLeadStateByPaneKey.delete(paneKey)
}
