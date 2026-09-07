import { describe, expect, it, vi } from 'vitest'
import { probeSshPtyLiveness } from './ssh-pty-liveness-probe'
import {
  parseRelayPtyMintEpoch,
  toRelayPtyIdWithMintEpoch
} from '../../shared/relay-pty-mint-epoch'

const EPOCH = '0f8f3a1e-1111-4111-8111-111111111111'
const PTY_ID = toRelayPtyIdWithMintEpoch(EPOCH, 7)

function relay(options: {
  listed?: { id: string }[] | null
  epoch?: string | null
  listThrows?: Error
  capabilitiesThrow?: Error
}) {
  return vi.fn(async (method: string) => {
    if (method === 'pty.listProcesses') {
      if (options.listThrows) {
        throw options.listThrows
      }
      return options.listed === undefined ? [] : options.listed
    }
    if (method === 'pty.getCapabilities') {
      if (options.capabilitiesThrow) {
        throw options.capabilitiesThrow
      }
      return options.epoch === null ? {} : { ptyIdMintEpoch: options.epoch ?? EPOCH }
    }
    throw new Error(`unexpected relay method ${method}`)
  })
}

describe('SSH PTY liveness probe', () => {
  it('answers live for an id the relay still lists', async () => {
    const request = relay({ listed: [{ id: PTY_ID }] })

    await expect(probeSshPtyLiveness({ request, relayPtyId: PTY_ID })).resolves.toBe(true)
    // A listed id needs no epoch comparison, so the second round trip is not spent.
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('certifies the exit when the relay that minted the id no longer lists it', async () => {
    const request = relay({ listed: [{ id: toRelayPtyIdWithMintEpoch(EPOCH, 8) }] })

    await expect(probeSshPtyLiveness({ request, relayPtyId: PTY_ID })).resolves.toBe(false)
  })

  it('certifies the exit even when the relay now lists nothing at all', async () => {
    // The population the recovery sweep meets: the worker was the host's only terminal and its
    // shell died while Orca was closed, so no listed id can name the current generation.
    const request = relay({ listed: [] })

    await expect(probeSshPtyLiveness({ request, relayPtyId: PTY_ID })).resolves.toBe(false)
  })

  it('stays unverifiable when a restarted relay disowns an id it never minted', async () => {
    const request = relay({ listed: [], epoch: 'ffffffff-2222-4222-8222-222222222222' })

    await expect(probeSshPtyLiveness({ request, relayPtyId: PTY_ID })).resolves.toBeNull()
  })

  it('stays unverifiable for a relay that names no mint epoch', async () => {
    const request = relay({ listed: [], epoch: null })

    await expect(probeSshPtyLiveness({ request, relayPtyId: PTY_ID })).resolves.toBeNull()
  })

  it('stays unverifiable for a legacy id that carries no epoch', async () => {
    const request = relay({ listed: [] })

    await expect(probeSshPtyLiveness({ request, relayPtyId: 'pty-4' })).resolves.toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the listing', { listThrows: new Error('Multiplexer disposed') }],
    ['the capability read', { capabilitiesThrow: new Error('SSH connection lost') }]
  ])('stays unverifiable when %s fails', async (_label, failure) => {
    const request = relay({ listed: [], ...failure })

    await expect(probeSshPtyLiveness({ request, relayPtyId: PTY_ID })).resolves.toBeNull()
  })

  it('stays unverifiable when the relay answers with no listing at all', async () => {
    const request = relay({ listed: null })

    await expect(probeSshPtyLiveness({ request, relayPtyId: PTY_ID })).resolves.toBeNull()
  })
})

describe('relay PTY mint epoch', () => {
  it('round-trips an epoch through an id', () => {
    expect(parseRelayPtyMintEpoch(toRelayPtyIdWithMintEpoch(EPOCH, 3))).toBe(EPOCH)
  })

  it('round-trips an epoch that needs escaping', () => {
    expect(parseRelayPtyMintEpoch(toRelayPtyIdWithMintEpoch('a:b/c d', 1))).toBe('a:b/c d')
  })

  it.each(['pty-4', 'pty2:', 'pty2::9', 'shell-1'])('names no epoch in %s', (id) => {
    expect(parseRelayPtyMintEpoch(id)).toBeNull()
  })
})
