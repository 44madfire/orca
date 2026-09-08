import { describe, expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { toRelayPtyIdWithMintEpoch } from '../../shared/relay-pty-mint-epoch'

const CONNECTION_ID = 'conn-1'
const RELAY_EPOCH = '0f8f3a1e-1111-4111-8111-111111111111'
const RELAY_PTY_ID = toRelayPtyIdWithMintEpoch(RELAY_EPOCH, 42)
const APP_PTY_ID = toAppSshPtyId(CONNECTION_ID, RELAY_PTY_ID)

/**
 * The provider is the owner the liveness rule routes to, so this pins the contract seam itself:
 * without `probePtyLiveness` on this class, `probePtyLivenessFromRuntimeController` answers null
 * for every SSH id and no SSH worker can ever be certified exited. The verdict itself belongs to
 * the relay; this class only carries the question to it.
 */
function makeProvider(status: 'live' | 'exited' | 'unknown') {
  const request = vi.fn(async (method: string) => {
    if (method === 'pty.probeLiveness') {
      return { status }
    }
    throw new Error(`unexpected relay method ${method}`)
  })
  const mux = {
    request,
    onNotification: () => () => {},
    onRequest: () => () => {}
  } as unknown as SshChannelMultiplexer
  return { provider: new SshPtyProvider(CONNECTION_ID, mux), request }
}

describe('SshPtyProvider liveness readback', () => {
  it('exposes the readback the liveness rule asks the owning provider for', () => {
    const { provider } = makeProvider('unknown')

    expect(typeof provider.probePtyLiveness).toBe('function')
  })

  it('answers live from the relay for an id its own cache has never seen', async () => {
    const { provider } = makeProvider('live')

    expect(provider.hasPty(APP_PTY_ID)).toBe(false)
    await expect(provider.probePtyLiveness(APP_PTY_ID)).resolves.toBe(true)
  })

  it('certifies an exit the relay observed', async () => {
    const { provider } = makeProvider('exited')

    await expect(provider.probePtyLiveness(APP_PTY_ID)).resolves.toBe(false)
  })

  it('refuses to answer for an id belonging to another SSH target', async () => {
    const { provider, request } = makeProvider('exited')

    await expect(
      provider.probePtyLiveness(toAppSshPtyId('other-conn', RELAY_PTY_ID))
    ).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})
