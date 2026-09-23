// Pi-family streaming dialect (PIF-5, 44madfire/orca#26).
//
// Small provider-aware normalization over the shared Pi record mapper. The
// common message/reasoning/tool semantics stay in `pi-record-mapping.ts` and
// `pi-turn-translator.ts`; only genuine lifecycle differences live here:
// terminal settlement (the flavor owns the boundary, never a hard-coded
// `agent_settled` check) and bounded OMP-only async facts.
//
// OMP extras policy: `prompt_result` and `available_commands_update` are
// facts for their owning subsystems (#25 dispatch correlation, #28 command
// discovery) so they are exposed, never journaled. Host tool/URI, subagent,
// notice, and protocol records are intentionally ignored: bounded, no state
// change, never persisted as raw journal JSON. Unknown future records stay
// forward-compatible the same way.

import { resolvePiFamilyFlavor } from '../pi-family-flavor'
import type { PiFamilyProvider } from '../rpc/pi-family-rpc-types'
import { mapPiRecordToSessionEvents } from './pi-record-mapping'
import type { PiSessionEvent } from './pi-session-events'

/** Handoff facts for owning subsystems; journal rows never carry these. */
export type PiFamilyPromptFact =
  | { kind: 'prompt-result'; agentInvoked: boolean }
  | { kind: 'commands-update'; count: number }

const MAX_PI_FAMILY_FACTS = 128

/** Bounded tray of handoff facts since the last drain (#25 seam). */
export class PiFamilyFactTray {
  private readonly facts: PiFamilyPromptFact[] = []

  observe(record: Record<string, unknown>): void {
    const fact = extractPiFamilyRecordFact(record)
    if (!fact) {
      return
    }
    this.facts.push(fact)
    if (this.facts.length > MAX_PI_FAMILY_FACTS) {
      this.facts.splice(0, this.facts.length - MAX_PI_FAMILY_FACTS)
    }
  }

  drain(): PiFamilyPromptFact[] {
    return this.facts.splice(0)
  }
}

/**
 * Extract the owning-subsystem fact from one async record, if any.
 * `prompt_result.agentInvoked:false` means the prompt completed locally with
 * no agent turn expected (#25); an absent field stays agent-expected. Counts
 * only, never payloads, so extras stay bounded and secret-safe.
 */
export function extractPiFamilyRecordFact(
  record: Record<string, unknown>
): PiFamilyPromptFact | null {
  const type = record['type']
  if (type === 'prompt_result') {
    return { kind: 'prompt-result', agentInvoked: record['agentInvoked'] !== false }
  }
  if (type === 'available_commands_update') {
    const commands = record['commands']
    return { kind: 'commands-update', count: Array.isArray(commands) ? commands.length : 0 }
  }
  return null
}

/**
 * Map one Pi-family RPC record to shared session events for `provider`.
 * Shared shapes pass through untouched; terminal settlement resolves through
 * the flavor (Pi settles on `agent_settled`, OMP on `agent_end` with
 * `isTerminal !== false`); provider errors become bounded generic failures
 * that never echo payload bytes. OMP extras map to `[]` here; their facts
 * surface via `extractPiFamilyRecordFact`.
 */
export function mapPiFamilyRecordToSessionEvents(
  record: Record<string, unknown>,
  provider: PiFamilyProvider = 'pi'
): PiSessionEvent[] {
  const type = record['type']
  if (type === 'error' || type === 'extension_error') {
    return [boundedFamilyError(record)]
  }
  const base = mapPiRecordToSessionEvents(record)
  if (base.length > 0) {
    return base
  }
  if (
    resolvePiFamilyFlavor(provider).isSettled({
      type: typeof type === 'string' ? type : '',
      isTerminal: record['isTerminal']
    })
  ) {
    const willRetry = record['willRetry'] === true
    return willRetry ? [{ type: 'settled', willRetry: true }] : [{ type: 'settled' }]
  }
  return base
}

/** Stable code only; the wire message may carry prompt/secret bytes. */
function boundedFamilyError(record: Record<string, unknown>): PiSessionEvent {
  const raw = record['code']
  const code =
    typeof raw === 'string' && raw.trim() !== ''
      ? raw.replace(/[\r\n]+/g, ' ').trim().slice(0, 80)
      : 'provider-error'
  return { type: 'error', code, message: 'provider dispatch failed' }
}
