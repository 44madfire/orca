// Orca-owned Pi-family JSONL RPC transport entry point (PIF-2, #23).
//
// One transport serves Pi-like AND OMP-like children: strict LF-delimited
// JSONL, id correlation, bounded deadlines, ambiguous-vs-definite errors,
// async subscribers, bounded/redacted stderr, pause/resume, exit
// observation, idempotent close, OMP `ready`/negotiation/`rpc_chunk`
// tolerance. Transport plumbing only: no session, journal, settlement
// predicate, history, or lifecycle semantics — terminal settlement stays
// provider-specific (`agent_settled` for Pi, terminal `agent_end` for OMP)
// and belongs to the lifecycle dialect (#25), never to this class.
// Typed command wrappers live in
// `pi-rpc-connection-commands.ts` and cover only the shared contract listed
// in `pi-family-rpc-types.ts`; command discovery stays provider-specific.
//
// Process ownership: the lifecycle layer injects the Orca spawn via
// `spawnFn` and reads `child`/`pid` immediately after `start()`, so PID and
// start-time identity stay authoritative outside this transport. Readiness
// is a bounded `get_state` round trip for both providers; OMP `ready`
// informs negotiation but never proves usability.

import { PiRpcConnection } from './pi-rpc-connection'
import type { PiFamilyProvider } from './pi-family-rpc-types'
import type { PiRpcConnectionOptions } from './pi-rpc-connection-state'

export type { PiFamilyProvider }
export type PiFamilyRpcConnectionOptions = PiRpcConnectionOptions

const PROVIDER_COMMAND: Record<PiFamilyProvider, string> = {
  pi: 'pi',
  omp: 'omp'
}

export class PiFamilyRpcConnection extends PiRpcConnection {
  readonly familyProvider: PiFamilyProvider

  constructor(options: PiFamilyRpcConnectionOptions = {}) {
    const provider = options.provider ?? 'pi'
    super({
      piCommand: PROVIDER_COMMAND[provider],
      ...options,
      provider
    })
    this.familyProvider = provider
  }
}
