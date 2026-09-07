import { describe, expect, it, vi } from 'vitest'
import { MobileRelayCredentialRefresh } from './mobile-relay-credential-refresh'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const rotated = {
  bundle: { v: 1, hostId: 'host-1' } as unknown as MobileRelayCredentialBundle,
  relay: { v: 1, directorUrl: 'https://relay.example', cellUrl: 'https://c1.relay.example' }
}
const rotate = vi.hoisted(() => vi.fn())
const needsRotation = vi.hoisted(() => vi.fn(() => true))
vi.mock('./mobile-relay-credential-rotation', () => ({
  mobileRelayCredentialNeedsRotation: needsRotation,
  rotateMobileRelayCredential: rotate
}))

function fixture(overrides: { persistResolvedRelay?: () => Promise<void> } = {}) {
  rotate.mockReset().mockResolvedValue(rotated)
  const order: string[] = []
  const refresh = new MobileRelayCredentialRefresh({
    logical: { getActivePath: () => 'direct' } as unknown as StableLogicalRpcClient,
    now: () => 1_000,
    randomBytes: (length) => new Uint8Array(length),
    writeBundle: async () => {},
    bundle: () => ({ v: 1, hostId: 'host-1' }) as unknown as MobileRelayCredentialBundle,
    adoptBundle: () => order.push('adopt'),
    persistResolvedRelay:
      overrides.persistResolvedRelay ??
      (async () => {
        order.push('persist')
      }),
    isStopped: () => false,
    completeRefresh: () => order.push('complete'),
    onRefreshed: () => order.push('refreshed')
  })
  return { refresh, order }
}

describe('MobileRelayCredentialRefresh', () => {
  it('does nothing unforced while the credential is still fresh', async () => {
    needsRotation.mockReturnValueOnce(false)
    const { refresh, order } = fixture()
    await refresh.run(false)
    expect(order).toEqual([])
    expect(rotate).not.toHaveBeenCalled()
  })

  it('lifts the gate and starts the relay race only after the endpoint is durable', async () => {
    const { refresh, order } = fixture()
    await refresh.run(true)
    expect(order).toEqual(['adopt', 'persist', 'complete', 'refreshed'])
  })

  it('keeps the gate closed when the endpoint write fails, so nothing dials the old cell', async () => {
    // Why: the adopted credential is durable, the endpoint is not. Lifting the gate here would
    // dial the pre-rotation cell with the post-rotation credential.
    const { refresh, order } = fixture({
      persistResolvedRelay: async () => {
        throw new Error('disk full')
      }
    })
    await expect(refresh.run(true)).resolves.toBeUndefined()
    expect(order).toEqual(['adopt'])
  })

  it('runs again after a failed persist instead of staying wedged in flight', async () => {
    let fail = true
    const { refresh, order } = fixture({
      persistResolvedRelay: async () => {
        if (fail) {
          throw new Error('disk full')
        }
        order.push('persist')
      }
    })
    await refresh.run(true)
    fail = false
    await refresh.run(true)
    expect(order).toEqual(['adopt', 'adopt', 'persist', 'complete', 'refreshed'])
  })
})
