import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dependencies, FakeLogicalClient, host } from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('direct dial grace', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('races the relay dial 500ms after a direct dial left handshaking', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    logical.publishState('handshaking')

    await vi.advanceTimersByTimeAsync(499)
    expect(deps.openRelay).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(deps.openRelay).toHaveBeenCalledOnce()
    supervisor.stop()
  })

  it('never opens a relay socket when direct authenticates inside the grace', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(300)
    logical.publishState('connected')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('lan')
    supervisor.stop()
  })
})
