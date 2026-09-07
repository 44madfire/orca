import { z } from 'zod'
import { MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES } from './bridge-limits'

const MethodSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/)

export const MobileWebHostRequestPayloadSchema = z
  .object({
    method: MethodSchema,
    workspaceId: z.string().min(1).max(160).optional(),
    params: z.record(z.string(), z.unknown())
  })
  .strict()

export const MobileWebHostResultSchema = z.unknown()
export type MobileWebHostRequestPayload = z.infer<typeof MobileWebHostRequestPayloadSchema>

/** The desktop cancel method for a subscribe method: only the trailing segment differs. Anything
 * that is not a subscribe method has no cancel and returns `undefined`, which callers treat as an
 * unsupported capability. */
export function mobileWebHostUnsubscribeMethod(method: string): string | undefined {
  if (method.endsWith('.watch')) {
    return `${method.slice(0, -'.watch'.length)}.unwatch`
  }
  if (method.endsWith('.subscribe')) {
    return `${method.slice(0, -'.subscribe'.length)}.unsubscribe`
  }
  return undefined
}

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
