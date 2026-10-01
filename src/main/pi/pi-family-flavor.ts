// Pi-family provider flavor (PIF-3, 44madfire/orca#24; settlement revised per #21).
//
// One PiFamilyStructuredSessionAdapter serves both discriminants; this tiny
// record holds the true provider differences needed for acquisition/close:
// which executable to spawn and which async event proves whole-session idle.
// It must NOT grow history/dispatch/translation/handoff methods (see #20);
// prompt-ack interpretation and the rest belong to later issues (#25+).
// Dialect table (run vs session finality, #20 baseline at PR 12900, #21 current):
// Pi run yield: turn_end (stop/aborted/error); Pi session idle: agent_settled.
// OMP PR12900 run yield: agent_end terminal; OMP PR12900 session idle: same frame (stale).
// OMP current run yield: agent_end terminal (one run yielded, session may wake).
// OMP current prompt outcome: id-correlated prompt_result (agentInvoked + sessionSettled).
// OMP current session idle: session_settled, or prompt_result sessionSettled:true.
// agent_end alone never proves session idle (live/admitted runs, queue, background can wake).

import type { PiFamilyProvider } from './rpc/pi-family-rpc-types'

/** Minimal async-record shape the settle predicates read; never the full journal. */
// id/sessionSettled are the BLOCK-1 prompt correlation shape, consumed here, never minted.
export type PiFamilySettledEvent = {
  readonly type: string
  readonly isTerminal?: unknown
  readonly id?: unknown
  readonly sessionSettled?: unknown
  readonly [key: string]: unknown
}

export type PiFamilyFlavor = {
  readonly provider: PiFamilyProvider
  readonly executable: 'pi' | 'omp'
  /** Whole-session idle predicate; run yields (OMP agent_end) never settle here. */
  readonly isSettled: (event: PiFamilySettledEvent) => boolean
}

function isPiSettled(event: PiFamilySettledEvent): boolean {
  return event.type === 'agent_settled'
}

// Whole-session idle: session_settled, or correlated prompt_result proving quiescence.
function isOmpSettled(event: PiFamilySettledEvent): boolean {
  if (event.type === 'session_settled') {
    return true
  }
  if (event.type === 'prompt_result' && event.sessionSettled === true) {
    return typeof event.id === 'string' && event.id !== ''
  }
  return false
}
// One agent run yielded; the session may still wake (runs, queue, background).
// Never session idle on its own; run journaling drains through turn_end mapping.
export function isOmpRunYield(event: PiFamilySettledEvent): boolean {
  return event.type === 'agent_end' && event.isTerminal !== false
}

const FLAVORS: Record<PiFamilyProvider, PiFamilyFlavor> = {
  pi: { provider: 'pi', executable: 'pi', isSettled: isPiSettled },
  omp: { provider: 'omp', executable: 'omp', isSettled: isOmpSettled }
}

export function resolvePiFamilyFlavor(provider: PiFamilyProvider): PiFamilyFlavor {
  return FLAVORS[provider]
}

/** Launch overrides; the flavor executable is the default per provider. */
export type PiFamilyLaunchConfig = {
  readonly piCommand?: string
  readonly piArgs?: readonly string[]
  readonly ompCommand?: string
  readonly ompArgs?: readonly string[]
}

/** Extra argv for acquire options (model/thinking), unless already pinned. */
export function argsForOptions(
  options: Readonly<Record<string, string>> | undefined,
  baseArgs: readonly string[]
): string[] {
  const extra: string[] = []
  if (options?.['model'] && !baseArgs.includes('--model')) {
    extra.push('--model', options['model'])
  }
  if (options?.['thinkingLevel'] && !baseArgs.includes('--thinking')) {
    extra.push('--thinking', options['thinkingLevel'])
  }
  return extra
}

/** Resolve the provider executable plus base argv (before `--mode rpc`). */
export function resolvePiFamilyLaunchCommand(
  provider: PiFamilyProvider,
  config: PiFamilyLaunchConfig
): { command: string; baseArgs: readonly string[] } {
  const flavor = resolvePiFamilyFlavor(provider)
  if (provider === 'omp') {
    return { command: config.ompCommand ?? flavor.executable, baseArgs: config.ompArgs ?? [] }
  }
  return { command: config.piCommand ?? flavor.executable, baseArgs: config.piArgs ?? [] }
}
