// Pi-family provider flavor (PIF-3, 44madfire/orca#24).
//
// One PiFamilyStructuredSessionAdapter serves both discriminants; this tiny
// record holds the true provider differences needed for acquisition/close:
// which executable to spawn and which async event finally settles a turn.
// It must NOT grow history/dispatch/translation/handoff methods (see #20);
// prompt-ack interpretation and the rest belong to later issues (#25+).

import type { PiFamilyProvider } from './rpc/pi-family-rpc-types'

/** Minimal async-record shape the settle predicates read; never the full journal. */
export type PiFamilySettledEvent = {
  readonly type: string
  readonly isTerminal?: unknown
  readonly [key: string]: unknown
}

export type PiFamilyFlavor = {
  readonly provider: PiFamilyProvider
  readonly executable: 'pi' | 'omp'
  /** Final-settle predicate for a live session; OMP non-terminal frames stay active. */
  readonly isSettled: (event: PiFamilySettledEvent) => boolean
}

function isPiSettled(event: PiFamilySettledEvent): boolean {
  return event.type === 'agent_settled'
}

function isOmpSettled(event: PiFamilySettledEvent): boolean {
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
