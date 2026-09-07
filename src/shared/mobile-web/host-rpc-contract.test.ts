import { describe, expect, it } from 'vitest'
import {
  MobileWebHostRequestPayloadSchema,
  MobileWebHostGrantSchema,
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
