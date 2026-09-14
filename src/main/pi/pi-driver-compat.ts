// Driver-side Pi compat enforcement (SNC1.10 Orca slice).
// Pre-spawn evidence plus static gates; live probes run post-start.
import {
  PI_STRUCTURED_ADVERTISED_CAPABILITIES,
  checkAcquireCompat,
  checkPiVersionSupport,
  type PiAcquireCompat
} from './pi-structured-compat'
import { verifyPiLiveCapabilities, type PiLiveProbeConnection } from './pi-live-capability-probe'
export type PiDriverCompatDeps = { requireCompat?: boolean; liveProbeTimeoutMs?: number }
// Throws PI_COMPAT_* before any child exists; safe for TUI fallback.
export function assertDriverAcquireCompat(
  input: { compat?: PiAcquireCompat },
  deps: PiDriverCompatDeps
): void {
  if (deps.requireCompat === true) {
    const versionEvidence =
      typeof input.compat?.piVersion === 'string' ? input.compat.piVersion.trim() : ''
    const capabilityEvidence = Array.isArray(input.compat?.requiredCapabilities)
      ? input.compat.requiredCapabilities.filter((c) => typeof c === 'string' && c !== '')
      : []
    if (versionEvidence === '' || capabilityEvidence.length === 0) {
      throw new Error(
        versionEvidence === ''
          ? 'PI_COMPAT_EVIDENCE_MISSING: acquire requires Pi version evidence (use Pi TUI)'
          : 'PI_COMPAT_EVIDENCE_MISSING: acquire requires a nonempty requiredCapabilities set (use Pi TUI)'
      )
    }
  }
  if (typeof input.compat?.piVersion === 'string') {
    const verdict = checkPiVersionSupport(input.compat.piVersion)
    if (!verdict.supported) {
      throw new Error(`PI_COMPAT_VERSION: ${verdict.reason} (use Pi TUI)`)
    }
  }
  if (input.compat !== undefined) {
    const verdict = checkAcquireCompat(input.compat, PI_STRUCTURED_ADVERTISED_CAPABILITIES)
    if (!verdict.allowed) {
      throw new Error(`${verdict.code}: ${verdict.reason} (use Pi TUI)`)
    }
  }
}
// Verifies live RPCs on the running child; caller closes the child on failure.
export async function verifyDriverLiveCompat(
  conn: PiLiveProbeConnection,
  input: { compat?: PiAcquireCompat },
  deps: PiDriverCompatDeps
): Promise<void> {
  const required = input.compat?.requiredCapabilities ?? []
  if (required.length === 0) {
    return
  }
  const failure = await verifyPiLiveCapabilities(conn, required, deps.liveProbeTimeoutMs ?? 5_000)
  if (failure !== null) {
    throw new Error(`PI_COMPAT_CAPABILITY: ${failure} (use Pi TUI)`)
  }
}
