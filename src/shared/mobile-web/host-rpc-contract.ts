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
    workspaceId: z.string().min(1).max(160),
    params: z.record(z.string(), z.unknown())
  })
  .strict()

export const MobileWebHostGrantSchema = z.object({
  method: MethodSchema,
  mode: z.enum(['once', 'subscription']).optional(),
  unsubscribeMethod: MethodSchema.optional(),
  workspaceParam: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z][A-Za-z0-9]*$/),
  maxRequestBytes: z.number().int().positive(),
  maxResponseBytes: z.number().int().positive()
})

export const MobileWebHostCatalogResultSchema = z.object({
  grants: z.array(MobileWebHostGrantSchema).max(32)
})

export const MobileWebHostResultSchema = z.unknown()
export type MobileWebHostGrant = z.infer<typeof MobileWebHostGrantSchema>
export type MobileWebHostRequestPayload = z.infer<typeof MobileWebHostRequestPayloadSchema>

export function mobileWebHostPayloadWithinBounds(value: unknown): boolean {
  const pending = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const entry = pending.pop()!
    if (++nodes > 40_000 || entry.depth > 32) {
      return false
    }
    if (entry.value !== null && typeof entry.value === 'object') {
      for (const child of Object.values(entry.value)) {
        pending.push({ value: child, depth: entry.depth + 1 })
        if (pending.length > 40_000) {
          return false
        }
      }
    } else if (
      entry.value !== null &&
      !['string', 'boolean', 'number'].includes(typeof entry.value)
    ) {
      return false
    }
  }
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES
  )
}
