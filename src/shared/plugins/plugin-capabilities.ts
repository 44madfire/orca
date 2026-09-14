import { z } from 'zod'

/**
 * Plugin capability model v0. The manifest declares capabilities, the user
 * consents against a fingerprint covering capabilities and worker trust, and the
 * host enforces at every plugin-callable boundary (panel bridge + worker host
 * API). Electron-free: shared by desktop main, headless serve, the relay
 * conformance path, and tests.
 *
 * v0 is a closed set of unscoped kinds so a typo (or a capability from a newer
 * Orca) fails manifest validation instead of silently granting nothing.
 * Scoped kinds (net:fetch hosts, process:exec globs) arrive in later phases.
 */

export const PLUGIN_CAPABILITY_KINDS = [
  'workspace:read',
  'terminal:send',
  'notifications:show',
  'storage',
  'secrets',
  'events:subscribe',
  'settings:own',
  'service:invoke'
] as const

export type PluginCapabilityKind = (typeof PLUGIN_CAPABILITY_KINDS)[number]

// Stable host-registered service ids: lowercase to keep consent, logs, and
// cross-platform wire bytes identical; no paths, slashes, or shell tokens.
export const PLUGIN_SERVICE_ID_MAX_LENGTH = 128
export const PLUGIN_SERVICE_IDS_PER_CAPABILITY_LIMIT = 16
const PLUGIN_SERVICE_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/

export function isSafePluginServiceId(serviceId: string): boolean {
  return (
    typeof serviceId === 'string' &&
    serviceId.length >= 1 &&
    serviceId.length <= PLUGIN_SERVICE_ID_MAX_LENGTH &&
    PLUGIN_SERVICE_ID_RE.test(serviceId)
  )
}

export const pluginServiceIdSchema = z
  .string()
  .min(1)
  .max(PLUGIN_SERVICE_ID_MAX_LENGTH)
  .refine(isSafePluginServiceId, 'must be a stable service id (a-z, 0-9, dot, dash, underscore)')

const pluginServiceIdsSchema = z
  .array(pluginServiceIdSchema)
  .min(1)
  .max(PLUGIN_SERVICE_IDS_PER_CAPABILITY_LIMIT)

// Strict object so scoped fields arrive per-kind without changing shape.
// serviceIds is required exactly for service:invoke and forbidden otherwise.
export const pluginCapabilitySchema = z
  .object({
    kind: z.enum(PLUGIN_CAPABILITY_KINDS),
    serviceIds: pluginServiceIdsSchema.optional()
  })
  .strict()
  .superRefine((capability, ctx) => {
    if (capability.kind === 'service:invoke') {
      if (!capability.serviceIds) {
        ctx.addIssue({ code: 'custom', message: 'service:invoke requires explicit serviceIds' })
      }
    } else if (capability.serviceIds !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'serviceIds is only allowed for service:invoke' })
    }
  })

export type PluginCapability = z.infer<typeof pluginCapabilitySchema>

/** Plain-language consent copy per capability. Shown verbatim in the install
 *  preview / consent dialog; keep each line honest about what is enforced. */
export const PLUGIN_CAPABILITY_DESCRIPTIONS: Record<PluginCapabilityKind, string> = {
  'workspace:read': 'Read the name, branch, and terminal list of your focused worktree',
  'terminal:send': 'Type text into a terminal you can see (always a specific terminal)',
  'notifications:show': 'Show desktop notifications labeled with the plugin name',
  storage: "Store data in the plugin's own storage folder",
  secrets: "Store and read secrets in the plugin's own encrypted vault",
  'events:subscribe':
    'Get notified when worktrees are created or removed and when agent status changes',
  'settings:own': "Read and change the plugin's own settings",
  'service:invoke': 'Invoke explicitly authorized host-registered services by id'
}

/**
 * Canonical serialization of a capability set. Order- and duplicate-
 * insensitive so consent is stable across manifest reformatting;
 * key-sorted so future scoped fields cannot produce two encodings of the
 * same grant.
 */
export function canonicalizeCapabilitySet(capabilities: readonly PluginCapability[]): string {
  const encoded = capabilities.map((capability) => {
    const normalized: Record<string, unknown> = {}
    const entries = Object.entries(capability).sort(([a], [b]) => a.localeCompare(b))
    for (const [key, value] of entries) {
      // serviceIds grant the same set regardless of declaration order.
      normalized[key] =
        key === 'serviceIds' && Array.isArray(value) ? [...new Set(value)].sort() : value
    }
    return JSON.stringify(normalized)
  })
  return JSON.stringify([...new Set(encoded)].sort())
}

export function capabilityKinds(capabilities: readonly PluginCapability[]): PluginCapabilityKind[] {
  return [...new Set(capabilities.map((capability) => capability.kind))]
}

// Least-privilege grant: union of explicitly authorized service ids.
// Sorted and deduped so consent and gate comparisons are order-stable.
export function collectGrantedServiceIds(capabilities: readonly PluginCapability[]): string[] {
  const ids = new Set<string>()
  for (const capability of capabilities) {
    if (capability.kind === 'service:invoke') {
      for (const serviceId of capability.serviceIds ?? []) {
        ids.add(serviceId)
      }
    }
  }
  return [...ids].sort()
}
