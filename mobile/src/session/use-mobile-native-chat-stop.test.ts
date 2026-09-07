import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import {
  MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import { useMobileNativeChatStop } from './use-mobile-native-chat-stop'

describe('useMobileNativeChatStop', () => {
  let renderer: ReactTestRenderer | null = null
  let stop: (() => void) | null = null
  const sendRequest = vi.fn()
  const onSendError = vi.fn()
  const agentRef = { current: null as string | null }
  const stopBackgroundTerminals = vi.fn<() => Promise<MobileNativeChatSendOutcome>>()

  beforeEach(() => {
    vi.useFakeTimers()
    sendRequest.mockReset().mockResolvedValue({
      ok: true,
      result: { send: { accepted: true } }
    })
    onSendError.mockReset()
    // Non-Codex by default so the existing Escape cases keep their behaviour.
    agentRef.current = 'claude'
    stopBackgroundTerminals.mockReset().mockResolvedValue('accepted')
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    stop = null
    vi.useRealTimers()
  })

  function Harness({
    enabled,
    streamIdentity
  }: {
    enabled: boolean
    streamIdentity: string
  }): null {
    stop = useMobileNativeChatStop({
      client: { sendRequest } as unknown as RpcClient,
      enabled,
      handleRef: { current: 'terminal-1' },
      deviceTokenRef: { current: 'mobile-1' },
      agentRef,
      streamIdentity,
      cancelPending: vi.fn(),
      stopBackgroundTerminals,
      onSendError
    })
    return null
  }

  async function render(enabled: boolean, streamIdentity: string): Promise<void> {
    await act(async () => {
      const element = createElement(Harness, { enabled, streamIdentity })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  it.each([
    ['the acknowledged input lease is lost', false, 'stream-1'],
    ['the active stream changes', true, 'stream-2']
  ])('cancels the delayed second Escape when %s', async (_case, enabled, streamIdentity) => {
    await render(true, 'stream-1')

    act(() => stop?.())
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await render(enabled as boolean, streamIdentity as string)
    await act(async () => vi.runAllTimersAsync())

    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('handles a rejected Escape without leaking an unhandled rejection', async () => {
    sendRequest.mockRejectedValue(new Error('disconnected'))
    await render(true, 'stream-1')

    act(() => stop?.())
    await act(async () => {
      await Promise.resolve()
      await vi.runAllTimersAsync()
    })

    expect(onSendError).toHaveBeenCalledOnce()
    expect(onSendError).toHaveBeenCalledWith('Stop not sent')
  })

  it.each([
    ['RPC failure', { ok: false, error: { code: 'stale', message: 'stale' } }],
    ['non-accepted send', { ok: true, result: { send: { accepted: false } } }]
  ])('reports Stop not sent after a resolved %s', async (_case, response) => {
    sendRequest.mockResolvedValue(response)
    await render(true, 'stream-1')

    act(() => stop?.())
    await act(async () => vi.runAllTimersAsync())

    expect(onSendError).toHaveBeenCalledOnce()
    expect(onSendError).toHaveBeenCalledWith('Stop not sent')
  })

  it.each([
    [
      'an ack lost after the frame was written',
      () => markRpcDeliveryUnknown(new Error('rpc timeout'))
    ],
    ['a logical client cutover', () => new Error('RPC interrupted by connection migration')]
  ])('reports Stop as unconfirmed after %s', async (_case, makeError) => {
    sendRequest.mockRejectedValue(makeError())
    await render(true, 'stream-1')

    act(() => stop?.())
    await act(async () => {
      await Promise.resolve()
      await vi.runAllTimersAsync()
    })

    // The Escape may have landed; a definite "not sent" invites a second Escape.
    expect(onSendError).toHaveBeenCalledOnce()
    expect(onSendError).toHaveBeenCalledWith('Stop unconfirmed — check chat before retrying')
  })

  it.each([
    ['second', 0],
    ['first', 1]
  ])('stays quiet when the %s Escape fails after its sibling landed', async (_case, failIndex) => {
    let call = 0
    sendRequest.mockImplementation(() => {
      const index = call
      call += 1
      return index === failIndex
        ? Promise.reject(markRpcDeliveryUnknown(new Error('rpc timeout')))
        : Promise.resolve({ ok: true, result: { send: { accepted: true } } })
    })
    await render(true, 'stream-1')

    act(() => stop?.())
    await act(async () => {
      await Promise.resolve()
      await vi.runAllTimersAsync()
    })

    // Two paced Escapes are one user action: either landing means the agent stopped,
    // so a straggler's failure must not tell the user to press Stop again.
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('bounds the Escape on a reconnect wait instead of parking forever', async () => {
    await render(true, 'stream-1')

    act(() => stop?.())

    // The budget covers the reconnect wait too, so a stop can't outlast its ceiling.
    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.anything(),
      expect.objectContaining({
        timeoutMs: MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS,
        budgetSpansConnect: true
      })
    )
  })

  it('suppresses an older Stop verdict after a newer Stop succeeds', async () => {
    let rejectFirst!: (error: Error) => void
    const first = new Promise((_, reject) => {
      rejectFirst = reject
    })
    sendRequest
      .mockReturnValueOnce(first)
      .mockResolvedValue({ ok: true, result: { send: { accepted: true } } })
    await render(true, 'stream-1')

    act(() => stop?.())
    act(() => stop?.())
    await act(async () => vi.runAllTimersAsync())
    await act(async () => {
      rejectFirst(new Error('late failure'))
      await Promise.resolve()
    })

    expect(onSendError).not.toHaveBeenCalled()
  })

  // Escape interrupts codex's TURN but leaves its background terminals running —
  // they are reaped only by `/stop` (see CODEX_STOP_BACKGROUND_TERMINALS).
  describe('codex background terminals', () => {
    it('reaps background terminals once the interrupt lands', async () => {
      agentRef.current = 'codex'
      await render(true, 'stream-1')

      act(() => stop?.())
      await act(async () => vi.runAllTimersAsync())

      expect(stopBackgroundTerminals).toHaveBeenCalledOnce()
      expect(onSendError).not.toHaveBeenCalled()
    })

    it('tells the user background terminals may still run when the cleanup is rejected', async () => {
      agentRef.current = 'codex'
      stopBackgroundTerminals.mockResolvedValue('rejected')
      await render(true, 'stream-1')

      act(() => stop?.())
      await act(async () => vi.runAllTimersAsync())

      expect(onSendError).toHaveBeenCalledWith(
        'Agent stopped; background terminals may still be running — send /stop'
      )
    })

    it('reports an ack-lost cleanup as unconfirmed rather than as a failure', async () => {
      agentRef.current = 'codex'
      stopBackgroundTerminals.mockResolvedValue('unknown')
      await render(true, 'stream-1')

      act(() => stop?.())
      await act(async () => vi.runAllTimersAsync())

      expect(onSendError).toHaveBeenCalledWith(
        'Agent stopped; background cleanup unconfirmed — check chat before retrying'
      )
    })

    // Typing a literal `/stop` into an agent that has no such command would post it
    // as a prompt, so the gate is an exact match, never "not claude".
    it.each([['claude'], ['opencode'], [null]])('never types /stop for agent %s', async (agent) => {
      agentRef.current = agent as string | null
      await render(true, 'stream-1')

      act(() => stop?.())
      await act(async () => vi.runAllTimersAsync())

      expect(stopBackgroundTerminals).not.toHaveBeenCalled()
    })

    it('skips the cleanup when neither Escape landed', async () => {
      agentRef.current = 'codex'
      sendRequest.mockResolvedValue({ ok: true, result: { send: { accepted: false } } })
      await render(true, 'stream-1')

      act(() => stop?.())
      await act(async () => vi.runAllTimersAsync())

      // Nothing was interrupted, so a `/stop` would land in a composer the user
      // still owns.
      expect(stopBackgroundTerminals).not.toHaveBeenCalled()
      expect(onSendError).toHaveBeenCalledWith('Stop not sent')
    })

    it('skips the cleanup when the route changed before the interrupt settled', async () => {
      agentRef.current = 'codex'
      await render(true, 'stream-1')

      act(() => stop?.())
      await render(true, 'stream-2')
      await act(async () => vi.runAllTimersAsync())

      expect(stopBackgroundTerminals).not.toHaveBeenCalled()
    })
  })
})
