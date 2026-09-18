// Session-option cluster for the external structured-session adapter.
//
// Split from `external-structured-session-adapter` (line budget): the provider-neutral
// option subset this seam accepts, its bridge round-trip, and the restore-failure ledger.
// Operates on caller-owned maps so the adapter keeps thin delegations.

import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionSetOptionInput } from '../structured-agent-session-adapter'
import type { BridgeSessionOptions } from './bridge-protocol'

/** Option keys the generic seam accepts (provider-neutral subset). */
export const EXTERNAL_OPTION_KEYS = new Set(['model', 'thinkingLevel', 'queueMode', 'autoCompaction'])

/** Host surface the option round-trip needs; structural so this file never names the adapter. */
export type ExternalSessionOptionsHost = {
  setOptions(sessionId: string, options: BridgeSessionOptions): Promise<BridgeSessionOptions>
}

export type ExternalSessionOptionsState = {
  hosts: Map<string, ExternalSessionOptionsHost>
  bridgeSessionByOrca: Map<string, string>
  sessionOptions: Map<string, BridgeSessionOptions>
  failures: Map<string, Set<string>>
}

function trackRestoreFailure(
  failures: Map<string, Set<string>>,
  sessionId: string,
  key: string
): void {
  let set = failures.get(sessionId)
  if (!set) {
    set = new Set()
    failures.set(sessionId, set)
  }
  set.add(key)
}

export async function setExternalSessionOption(
  state: ExternalSessionOptionsState,
  input: StructuredAgentSessionSetOptionInput
): Promise<void | Readonly<Record<string, string>>> {
  const host = state.hosts.get(input.sessionId)
  const bridgeSessionId = state.bridgeSessionByOrca.get(input.sessionId)
  if (!host || !bridgeSessionId) {throw new Error(`no live external session ${input.sessionId}`)}
  if (!EXTERNAL_OPTION_KEYS.has(input.key)) {
    throw new Error(`external bridge has no option named ${input.key}`)
  }
  const current = state.sessionOptions.get(input.sessionId) ?? {}
  const next: BridgeSessionOptions = { ...current }
  if (input.key === 'model') {next.model = input.value}
  else if (input.key === 'thinkingLevel') {next.thinkingLevel = input.value}
  else if (input.key === 'queueMode') {
    if (input.value !== 'reject' && input.value !== 'steer' && input.value !== 'followUp') {
      trackRestoreFailure(state.failures, input.sessionId, input.key)
      throw new Error(`invalid queueMode ${input.value}`)
    }
    next.queueMode = input.value
  } else if (input.key === 'autoCompaction') {
    if (input.value !== 'true' && input.value !== 'false') {
      trackRestoreFailure(state.failures, input.sessionId, input.key)
      throw new Error(`invalid autoCompaction ${input.value}`)
    }
    next.autoCompaction = input.value === 'true'
  }
  const updated = await host.setOptions(bridgeSessionId, next)
  state.sessionOptions.set(input.sessionId, { ...updated })
  const record: Record<string, string> = {}
  if (updated.model) {record['model'] = updated.model}
  if (updated.thinkingLevel) {record['thinkingLevel'] = updated.thinkingLevel}
  if (updated.queueMode) {record['queueMode'] = updated.queueMode}
  if (typeof updated.autoCompaction === 'boolean')
    {record['autoCompaction'] = String(updated.autoCompaction)}
  return record
}

export async function readExternalSessionOptions(
  state: ExternalSessionOptionsState,
  input: { sessionId: string; fence: number }
): Promise<AgentSessionOptionsResult> {
  const cached = state.sessionOptions.get(input.sessionId) ?? {}
  // Generic seam: no provider catalog to report (models:[] keeps the client
  // on its own catalog until SNC1.6 proves Pi models). thinkingLevel rides
  // as `effort`, the closest wire-level knob.
  return {
    models: [],
    current: {
      model: cached.model ?? 'external',
      ...(cached.thinkingLevel ? { effort: cached.thinkingLevel } : {}),
    },
  }
}

export function readExternalOptionRestoreFailures(
  failures: Map<string, Set<string>>,
  sessionId: string
): readonly string[] {
  return [...(failures.get(sessionId) ?? [])]
}
