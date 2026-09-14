// Production Pi compat wiring for the structured host (SNC1.10 Orca slice).
// Probes `pi --version` once per install, bounded, out of band; test
// harnesses with a spawn override keep deterministic floor evidence.
import {
  MIN_KNOWN_GOOD_PI_VERSION,
  PI_STRUCTURED_REQUIRED_CAPABILITIES
} from './pi-structured-compat'
import { probePiVersionBounded } from './pi-version-probe'
export type PiRuntimeCompat = {
  readonly piVersion: string | null
  readonly requiredCapabilities: readonly string[]
  readonly requireCompatEvidence: boolean
  readonly requireCompat: boolean
}
export type PiRuntimeCompatOverrides = {
  piVersion?: string | null
  requiredCapabilities?: readonly string[]
  requireCompatEvidence?: boolean
  requireCompat?: boolean
}
// Production demands evidence; scripted harnesses default to permissive.
export async function resolvePiRuntimeCompat(input: {
  spawnOverridePresent: boolean
  overrides?: PiRuntimeCompatOverrides
  probeCommand?: string
}): Promise<PiRuntimeCompat> {
  if (input.overrides !== undefined) {
    const floor = MIN_KNOWN_GOOD_PI_VERSION
    return {
      piVersion: input.overrides.piVersion !== undefined ? input.overrides.piVersion : floor,
      requiredCapabilities:
        input.overrides.requiredCapabilities !== undefined
          ? input.overrides.requiredCapabilities
          : PI_STRUCTURED_REQUIRED_CAPABILITIES,
      requireCompatEvidence: input.overrides.requireCompatEvidence ?? false,
      requireCompat: input.overrides.requireCompat ?? false
    }
  }
  if (input.spawnOverridePresent) {
    return {
      piVersion: MIN_KNOWN_GOOD_PI_VERSION,
      requiredCapabilities: PI_STRUCTURED_REQUIRED_CAPABILITIES,
      requireCompatEvidence: false,
      requireCompat: false
    }
  }
  let piVersion: string | null = null
  try {
    const probed =
      input.probeCommand !== undefined
        ? await probePiVersionBounded({ command: input.probeCommand })
        : await probePiVersionBounded()
    piVersion = probed.ok ? probed.version : null
  } catch {
    piVersion = null
  }
  return {
    piVersion,
    requiredCapabilities: PI_STRUCTURED_REQUIRED_CAPABILITIES,
    requireCompatEvidence: true,
    requireCompat: true
  }
}
