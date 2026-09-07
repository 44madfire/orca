import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES } from './bridge-limits'
import {
  MobileWebHostRequestPayloadSchema,
  MobileWebHostGrantSchema,
  mobileWebHostPayloadByteLength,
  mobileWebHostPayloadWithinBounds
} from './host-rpc-contract'

describe('generic host payload transport', () => {
  it('preserves unknown domain fields but rejects unknown envelope fields', () => {
    const payload = {
      method: 'future.read',
      workspaceId: 'opaque',
      params: { future: { kind: 'new' } }
    }
    expect(MobileWebHostRequestPayloadSchema.parse(payload)).toEqual(payload)
    expect(
      MobileWebHostRequestPayloadSchema.safeParse({ ...payload, nativeAuthority: true }).success
    ).toBe(false)
  })
  it('requires explicit host scope before a grant can omit its workspace parameter', () => {
    const grant = { method: 'future.hostSetting', maxRequestBytes: 1024, maxResponseBytes: 1024 }
    expect(MobileWebHostGrantSchema.safeParse(grant).success).toBe(false)
    expect(MobileWebHostGrantSchema.safeParse({ ...grant, scope: 'host' }).success).toBe(true)
    expect(
      MobileWebHostGrantSchema.safeParse({ ...grant, workspaceParam: 'worktree' }).success
    ).toBe(true)
    expect(
      MobileWebHostGrantSchema.safeParse({ ...grant, scope: 'host', workspaceParam: 'worktree' })
        .success
    ).toBe(false)
  })
  it('refuses a grant advertising more than a shipped shell can deliver', () => {
    const grant = { method: 'future.read', scope: 'host' as const, maxRequestBytes: 1024 }
    const envelope = MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES
    expect(
      MobileWebHostGrantSchema.safeParse({ ...grant, maxResponseBytes: envelope }).success
    ).toBe(true)
    expect(
      MobileWebHostGrantSchema.safeParse({ ...grant, maxResponseBytes: envelope + 1 }).success
    ).toBe(false)
    expect(
      MobileWebHostGrantSchema.safeParse({
        ...grant,
        maxRequestBytes: envelope + 1,
        maxResponseBytes: 1024
      }).success
    ).toBe(false)
  })

  it('reports the encoded length once for callers that also need the verdict', () => {
    expect(mobileWebHostPayloadByteLength({ future: 'value' })).toBe(
      new TextEncoder().encode(JSON.stringify({ future: 'value' })).byteLength
    )
    expect(mobileWebHostPayloadByteLength('é'.repeat(310 * 1024))).toBeUndefined()
    expect(mobileWebHostPayloadByteLength(() => {})).toBeUndefined()
  })

  it('bounds depth, node count and encoded bytes independently of domain shape', () => {
    let nested: unknown = null
    for (let i = 0; i < 34; i++) {
      nested = { nested }
    }
    expect(mobileWebHostPayloadWithinBounds(nested)).toBe(false)
    expect(mobileWebHostPayloadWithinBounds(Array(40_001).fill(null))).toBe(false)
    expect(mobileWebHostPayloadWithinBounds('é'.repeat(310 * 1024))).toBe(false)
    expect(mobileWebHostPayloadWithinBounds({ future: [{ value: true }] })).toBe(true)
  })
})
