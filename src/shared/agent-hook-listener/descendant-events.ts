import type { AgentHookSource } from '../agent-hook-relay'
import { readFirstString } from './interactive-tool'
import { isGrokEvent, normalizeHookEventName } from './provider-event-names'

/** What one hook event says about a DESCENDANT of the pane's lead session.
 *
 *  A descendant's lifecycle is not the pane's: it may add or remove a child row,
 *  and it may never settle the pane or fire completion. `id` is optional because
 *  some providers only mark an event as "this fired inside a child" without
 *  naming which one — that is still enough to refuse the settle. */
export type DescendantEventFacts = {
  id?: string
  agentType?: string
  description?: string
  model?: string
  /** The descendant's own turn or session ended. */
  ended: boolean
}

/** Providers whose normalizer already tracks its own descendants and derives the
 *  pane state from them. Claude's roster carries teammate parking, background-task
 *  folding and restored-snapshot provenance; Codex's carries per-child models and
 *  rollout reconciliation. Both already implement the pane rule, so the generic
 *  path must not run a second, blinder copy over the same events. */
export function providerOwnsDescendantLifecycle(source: AgentHookSource): boolean {
  return source === 'claude' || source === 'codex'
}

/** Provider-assigned child id under the names hook payloads actually use. */
function readDescendantId(hookPayload: Record<string, unknown>): string | undefined {
  return readFirstString(hookPayload, [
    'subagentId',
    'subagent_id',
    'agentId',
    'agent_id',
    'runId',
    'run_id'
  ])
}

function readGrokDescendantFacts(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): DescendantEventFacts | null {
  const isLifecycleEvent = isGrokEvent(eventName, 'subagent_start', 'subagent_stop', 'subagent_end')
  const subagentType = readFirstString(hookPayload, ['subagentType', 'subagent_type'])
  // Why: grok stamps `subagentType` on every event that can fire inside a child and omits it in
  // the main session, so its presence — not the event name — is what tells a child apart. A
  // background child outlives the parent turn and inherits the pane key, so without this its
  // SessionEnd/StopFailure lands on the parent as a completion.
  if (!isLifecycleEvent && subagentType === undefined) {
    return null
  }
  return {
    id: readFirstString(hookPayload, ['subagentId', 'subagent_id']),
    agentType: subagentType,
    description: readFirstString(hookPayload, ['description']),
    ended:
      isGrokEvent(eventName, 'subagent_stop', 'subagent_end') ||
      (subagentType !== undefined &&
        isGrokEvent(eventName, 'stop', 'session_end', 'stop_failure', 'stop_cancelled'))
  }
}

function readPiDescendantFacts(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): DescendantEventFacts | null {
  const normalized = normalizeHookEventName(eventName)
  if (normalized !== 'subagent_async_started' && normalized !== 'subagent_async_complete') {
    return null
  }
  return {
    id: readDescendantId(hookPayload),
    agentType: readFirstString(hookPayload, ['agentType', 'agent_type', 'subagentType']),
    description: readFirstString(hookPayload, ['description', 'task', 'prompt']),
    model: readFirstString(hookPayload, ['model']),
    ended: normalized === 'subagent_async_complete'
  }
}

/** Read a descendant out of one provider's hook event, or null when the event
 *  belongs to the pane's lead session.
 *
 *  Exhaustive on purpose: a new provider has to answer "does this CLI report
 *  child sessions on the parent's pane?" here rather than inherit a guess. The
 *  answer is one line, and `readDescendantId` covers the field names in use. */
export function readDescendantEventFacts(
  source: AgentHookSource,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): DescendantEventFacts | null {
  switch (source) {
    // Why: both own their rosters; `providerOwnsDescendantLifecycle` already routes around this,
    // and answering here too would let a future caller run the generic path over their events.
    case 'claude':
    case 'codex':
      return null
    case 'grok':
      return readGrokDescendantFacts(eventName, hookPayload)
    case 'pi':
    case 'omp':
    case 'prime-agent':
      return readPiDescendantFacts(eventName, hookPayload)
    case 'gemini':
    case 'antigravity':
    case 'amp':
    case 'opencode':
    case 'mimo-code':
    case 'cursor':
    case 'droid':
    case 'command-code':
    case 'copilot':
    case 'hermes':
    case 'devin':
    case 'kimi':
      // No child-session hook surface reaches Orca for these today. When one gains
      // one, read it here — the roster and the pane rule already exist.
      return null
  }
}

/** An event that replaces the pane's agent process, so descendants of the process
 *  it replaced can no longer be alive. The roster's recovery from a lost child
 *  stop: without it a dropped stop hook would pin the pane 'working' forever. */
export function isDescendantScopeResetEvent(source: AgentHookSource, eventName: unknown): boolean {
  switch (source) {
    case 'grok':
      return isGrokEvent(eventName, 'session_start')
    case 'pi':
    case 'omp':
    case 'prime-agent':
      return eventName === 'session_start'
    default:
      return false
  }
}
