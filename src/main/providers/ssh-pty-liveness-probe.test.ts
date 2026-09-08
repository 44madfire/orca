import { describe, expect, it, vi } from 'vitest'
import { probeSshPtyLiveness } from './ssh-pty-liveness-probe'

const PTY_ID = 'pty2:0f8f3a1e-1111-4111-8111-111111111111:7'

function relay(answer: Error | Record<string, unknown> | null) {
  return vi.fn(async (method: string, params?: Record<string, unknown>) => {
    expect(method).toBe('pty.probeLiveness')
    expect(params).toEqual({ id: PTY_ID })
    if (answer instanceof Error) {
      throw answer
    }
    return answer
  })
}

describe('SSH PTY liveness forwarder', () => {
  it.each([
    ['live', true],
    ['exited', false],
    ['unknown', null]
  ])('maps the owner verdict %s', async (status, expected) => {
    const request = relay({ status })

    await expect(probeSshPtyLiveness({ request, relayPtyId: PTY_ID })).resolves.toBe(expected)
    // One exact-id question, so the client neither scans an inventory nor interprets one.
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a relay too old to know the method', new Error('Method not found: pty.probeLiveness')],
    ['a disposed multiplexer', new Error('Multiplexer disposed')],
    ['a lost connection', new Error('SSH connection lost, reconnecting...')]
  ])('fails closed on %s', async (_label, failure) => {
    const request = relay(failure)

    await expect(probeSshPtyLiveness({ request, relayPtyId: PTY_ID })).resolves.toBeNull()
  })

  it.each([
    ['no answer at all', null],
    ['an answer with no status', {}],
    ['a status this client does not know', { status: 'probably_gone' }],
    ['a non-string status', { status: true }]
  ])('refuses to read %s as a verdict', async (_label, answer) => {
    const request = relay(answer)

    await expect(probeSshPtyLiveness({ request, relayPtyId: PTY_ID })).resolves.toBeNull()
  })
})
