import { z } from 'zod'
import { MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES } from './bridge-limits'

const MethodSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/)

export const MobileWebHostCatalogPayloadSchema = z
  .object({ methods: z.array(MethodSchema).min(1).max(32) })
  .strict()

export const MobileWebHostRequestPayloadSchema = z
  .object({
    method: MethodSchema,
    workspaceId: z.string().min(1).max(160).optional(),
    params: z.record(z.string(), z.unknown())
  })
  .strict()

export const MobileWebHostGrantSchema = z
  .object({
    method: MethodSchema,
    scope: z.enum(['workspace', 'host']).optional(),
    mode: z.enum(['once', 'subscription']).optional(),
    unsubscribeMethod: MethodSchema.optional(),
    workspaceParam: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z][A-Za-z0-9]*$/)
      .optional(),
    maxRequestBytes: z.number().int().positive().max(MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES),
    maxResponseBytes: z.number().int().positive().max(MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES)
  })
  .refine(
    (grant) =>
      grant.scope === 'host'
        ? grant.workspaceParam === undefined
        : grant.workspaceParam !== undefined,
    'Grant scope and workspace parameter must agree'
  )

export const MobileWebHostCatalogResultSchema = z.object({
  grants: z.array(MobileWebHostGrantSchema).max(32)
})

export const MobileWebHostResultSchema = z.unknown()
export type MobileWebHostGrant = z.infer<typeof MobileWebHostGrantSchema>
export type MobileWebHostRequestPayload = z.infer<typeof MobileWebHostRequestPayloadSchema>

export function mobileWebHostPayloadWithinBounds(value: unknown): boolean {
  return mobileWebHostPayloadByteLength(value) !== undefined
}

/** Encoded length, or undefined when the value cannot cross the bridge at all. Callers that need
 * both the verdict and the size must use this, not a second serialization. */
export function mobileWebHostPayloadByteLength(value: unknown): number | undefined {
  const pending = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const entry = pending.pop()!
    if (++nodes > 40_000 || entry.depth > 32) {
      return undefined
    }
    if (entry.value !== null && typeof entry.value === 'object') {
      for (const child of Object.values(entry.value)) {
        pending.push({ value: child, depth: entry.depth + 1 })
        if (pending.length > 40_000) {
          return undefined
        }
      }
    } else if (
      entry.value !== null &&
      !['string', 'boolean', 'number'].includes(typeof entry.value)
    ) {
      return undefined
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  return bytes <= MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES ? bytes : undefined
}
