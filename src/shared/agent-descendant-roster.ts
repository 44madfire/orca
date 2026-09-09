import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_MAX_SUBAGENTS,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  type AgentStatusState,
  type AgentSubagentSnapshot
} from './agent-status-types'
import { normalizeOptionalField } from './agent-status-field-normalization'

/** Live descendants (subagents, spawned threads, async child runs) of one pane's
 *  lead agent session, keyed by the provider-assigned child id.
 *
 *  Provider-agnostic on purpose: the pane rule "idle only when the lead is idle
 *  AND no descendant is live" is one concept, so it has one implementation. A
 *  provider contributes only how to READ a child out of its hook events
 *  (`agent-hook-listener/descendant-events.ts`). Claude keeps its own roster
 *  because its children carry provider-specific reconciliation (teammate
 *  parking, `background_tasks` folding, restored-snapshot provenance) that no
 *  other provider has; it implements the same pane rule in
 *  `providers/claude-roster-state.ts`. */

const AGENT_DESCENDANT_ID_MAX_LENGTH = 64

export type AgentDescendantRoster = Map<string, TrackedAgentDescendant>

type TrackedAgentDescendant = {
  agentType?: string
  description?: string
  model?: string
  state: 'working' | 'waiting'
  startedAt: number
}

export function upsertAgentDescendant(
  roster: AgentDescendantRoster,
  id: string,
  fields: {
    agentType?: string
    description?: string
    model?: string
    state: 'working' | 'waiting'
  },
  now: number
): void {
  const normalizedId = id.trim()
  if (normalizedId.length === 0 || normalizedId.length > AGENT_DESCENDANT_ID_MAX_LENGTH) {
    return
  }
  const agentType = normalizeOptionalField(fields.agentType, AGENT_TYPE_MAX_LENGTH)
  const description = normalizeOptionalField(fields.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  const model = normalizeOptionalField(fields.model, AGENT_MODEL_MAX_LENGTH)
  const existing = roster.get(normalizedId)
  if (existing) {
    existing.agentType = agentType ?? existing.agentType
    existing.description = description ?? existing.description
    existing.model = model ?? existing.model
    existing.state = fields.state
    return
  }
  if (roster.size >= AGENT_STATUS_MAX_SUBAGENTS) {
    return
  }
  roster.set(normalizedId, {
    agentType,
    description,
    model,
    state: fields.state,
    startedAt: now
  })
}

export function finishAgentDescendant(roster: AgentDescendantRoster, id: string): void {
  roster.delete(id.trim())
}

/**
 * Record the model a already-tracked child is running. Deliberately narrower
 * than `upsertAgentDescendant`: it never creates a roster entry and never touches
 * `state`, so late model discovery from a child rollout cannot resurrect a
 * finished child nor move any child's lifecycle.
 */
export function setAgentDescendantModel(
  roster: AgentDescendantRoster,
  id: string,
  model: string | undefined
): void {
  const normalizedModel = normalizeOptionalField(model, AGENT_MODEL_MAX_LENGTH)
  if (!normalizedModel) {
    return
  }
  const existing = roster.get(id.trim())
  if (!existing) {
    return
  }
  existing.model = normalizedModel
}

export function seedAgentDescendantRoster(
  roster: AgentDescendantRoster,
  snapshots: readonly AgentSubagentSnapshot[]
): void {
  for (const snapshot of snapshots) {
    if (snapshot.state !== 'working' && snapshot.state !== 'waiting') {
      continue
    }
    upsertAgentDescendant(
      roster,
      snapshot.id,
      {
        agentType: snapshot.agentType,
        description: snapshot.description,
        model: snapshot.model,
        state: snapshot.state
      },
      snapshot.startedAt
    )
  }
}

export function agentDescendantRosterToSnapshots(
  roster: AgentDescendantRoster | undefined
): AgentSubagentSnapshot[] | undefined {
  if (!roster || roster.size === 0) {
    return undefined
  }
  const snapshots = Array.from(roster, ([id, tracked]) => ({
    id,
    agentType: tracked.agentType,
    description: tracked.description,
    model: tracked.model,
    state: tracked.state,
    startedAt: tracked.startedAt
  }))
  snapshots.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  return snapshots
}

/** The pane's state once its live descendants are taken into account: a lead
 *  `done` is only the pane's `done` when nothing is still running under it. A
 *  descendant blocked on a human answer outranks the lead's own working state,
 *  since that wait is the actionable one. */
export function agentDescendantEffectiveState(
  roster: AgentDescendantRoster | undefined,
  leadState: AgentStatusState
): AgentStatusState {
  if (!roster || roster.size === 0) {
    return leadState
  }
  for (const tracked of roster.values()) {
    if (tracked.state === 'waiting') {
      return 'waiting'
    }
  }
  return leadState === 'done' ? 'working' : leadState
}
