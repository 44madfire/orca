// Production Pi compat wiring for the structured host (SNC1.10 Orca slice).
// Version probing is lazy to first Pi acquire (never blocks Codex/Claude)
// and uses the same resolved launch env as the Pi child (GUI PATH safe).
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
  resolveEnv?: () => Promise<NodeJS.ProcessEnv> | NodeJS.ProcessEnv
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
    const env = await input.resolveEnv?.()
    const probed =
      input.probeCommand !== undefined
        ? env !== undefined
          ? await probePiVersionBounded({ command: input.probeCommand, env })
          : await probePiVersionBounded({ command: input.probeCommand })
        : env !== undefined
          ? await probePiVersionBounded({ env })
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
// Lazy probe for production install: construction never blocks; the first Pi
// acquire pays one bounded probe with the Pi launch env, later acquires reuse.
export function createLazyPiVersionProbe(input: {
  resolveEnv: () => Promise<NodeJS.ProcessEnv> | NodeJS.ProcessEnv
  command?: string
}): () => Promise<string | null> {
  let cached: Promise<string | null> | null = null
  return () => {
    cached ??= (async () => {
      try {
        const env = await input.resolveEnv()
        const probed = await probePiVersionBounded({
          ...(input.command !== undefined ? { command: input.command } : {}),
          env
        })
        return probed.ok ? probed.version : null
      } catch {
        return null
      }
    })()
    return cached
  }
}
