import { beforeEach, describe, expect, it, vi } from 'vitest'
const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({ callStructuredAgentSession: call }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
import { forkStructuredSessionFromTurn } from './structured-agent-session-fork-command'

let id = 0
const input = () => ({
  target: { kind: 'local' } as const,
  worktree: 'workspace',
  agent: 'codex' as const,
  source: {
    sessionId: `parent-${++id}`,
    itemId: 'codex:parent:turn:1',
    expectedEpoch: 'epoch',
    expectedRuntimeFence: 1
  }
})
beforeEach(() => {
  call.mockReset()
})

describe('fork create intent replay', () => {
  it('replays the exact child id and operation after a lost reply', async () => {
    const args = input()
    call
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockResolvedValueOnce({ ok: true, value: { sessionId: 'child' } })
    await expect(forkStructuredSessionFromTurn(args)).rejects.toThrow('could not be confirmed')
    await forkStructuredSessionFromTurn(args)
    expect(call.mock.calls[1]?.[2]).toEqual(call.mock.calls[0]?.[2])
    expect(call.mock.calls[0]?.[2]).toMatchObject({
      forkFrom: args.source,
      envelope: { expectedRuntimeFence: null }
    })
  })

  it('routes the create to the parent execution host and never falls back locally', async () => {
    const args = {
      ...input(),
      target: { kind: 'environment', environmentId: 'remote-host' } as const
    }
    call.mockRejectedValue(new Error('unreachable'))
    await expect(forkStructuredSessionFromTurn(args)).rejects.toThrow('could not be confirmed')
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]?.[0]).toEqual(args.target)
  })

  it('joins simultaneous clicks into one create request', async () => {
    let finish!: (value: unknown) => void
    call.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const args = input()
    const first = forkStructuredSessionFromTurn(args)
    const second = forkStructuredSessionFromTurn(args)
    expect(second).toBe(first)
    finish({ ok: true })
    await first
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('allows a fresh attempt after a pre-commit busy refusal', async () => {
    const args = input()
    call
      .mockResolvedValueOnce({ ok: false, refusal: { forkReason: 'busy' } })
      .mockResolvedValueOnce({ ok: true })
    await expect(forkStructuredSessionFromTurn(args)).rejects.toThrow('Wait for the conversation')
    await forkStructuredSessionFromTurn(args)
    expect(call.mock.calls[1]?.[2].envelope.sessionId).not.toBe(
      call.mock.calls[0]?.[2].envelope.sessionId
    )
  })
})
