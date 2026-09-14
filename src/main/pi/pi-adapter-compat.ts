// Adapter-side Pi compat gate (SNC1.10 Orca slice).
// Builds the acquire-time evidence object and enforces the static gate
// before any child exists; live probes run in the driver post-start.
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  PI_STRUCTURED_ADVERTISED_CAPABILITIES,
  PI_STRUCTURED_REQUIRED_CAPABILITIES,
  checkAcquireCompat,
  type PiAcquireCompat
} from './pi-structured-compat'
export type PiAdapterCompatDeps = {
  requireCompatEvidence?: boolean
  piVersion?: string | null
  requiredCapabilities?: readonly string[]
}
export function buildPiAdapterCompat(
  input: StructuredAgentSessionAcquireInput,
  deps: PiAdapterCompatDeps
): PiAcquireCompat | null {
  const versionRaw = typeof deps.piVersion === 'string' ? deps.piVersion.trim() : ''
  const required = Array.isArray(deps.requiredCapabilities)
    ? deps.requiredCapabilities.filter((c) => typeof c === 'string' && c !== '')
    : [...PI_STRUCTURED_REQUIRED_CAPABILITIES]
  const hasLocation = input.location !== undefined
  const hasVersion = versionRaw !== ''
  const hasCapabilities = required.length > 0
  if (deps.requireCompatEvidence === true && (!hasVersion || !hasCapabilities)) {
    throw new AgentSessionPreSpawnError(
      !hasVersion
        ? 'PI_COMPAT_EVIDENCE_MISSING: acquire requires Pi version evidence (use Pi TUI)'
        : 'PI_COMPAT_EVIDENCE_MISSING: acquire requires a nonempty requiredCapabilities set (use Pi TUI)'
    )
  }
  if (!hasLocation && !hasVersion && !hasCapabilities) {
    return null
  }
  return {
    ...(hasVersion ? { piVersion: versionRaw } : {}),
    ...(hasLocation
      ? { executionHostId: input.location!.executionHostId, wslDistro: input.location!.wslDistro }
      : {}),
    ...(hasCapabilities ? { requiredCapabilities: Object.freeze([...required]) } : {})
  }
}
export function assertPiAdapterCompat(compat: PiAcquireCompat | null): void {
  if (compat === null) {
    return
  }
  const verdict = checkAcquireCompat(compat, PI_STRUCTURED_ADVERTISED_CAPABILITIES)
  if (!verdict.allowed) {
    throw new AgentSessionPreSpawnError(`${verdict.code}: ${verdict.reason} (use Pi TUI)`)
  }
}
