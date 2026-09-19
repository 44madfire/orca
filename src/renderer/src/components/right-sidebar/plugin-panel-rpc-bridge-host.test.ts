import { describe, expect, it, vi } from 'vitest'
import type { PluginPanelRpcOutcome } from '../../../../shared/plugins/plugin-panel-bridge'
import { createPanelMessageBudget } from '../../../../shared/plugins/plugin-panel-message-budget'
import { createPanelBridgeMessageHandler } from './plugin-panel-bridge-host'

type FakePanelWindow = Window & { postMessage: ReturnType<typeof vi.fn> }

function createFakePanelWindow(): FakePanelWindow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge handler reads only postMessage from the panel window and compares it by identity; the double supplies exactly that member and every test asserts the reply lands on the same object.
  return { postMessage: vi.fn() } as unknown as FakePanelWindow
}

function messageEvent(data: unknown, source: unknown): MessageEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge handler reads only event.data and event.source; the double carries exactly those two members and every test asserts dispatch/reply behavior on the result.
  return { data, source } as unknown as MessageEvent
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const VALID_RPC = {
  type: 'orca-panel-rpc',
  requestId: 'rpc-1',
  method: 'panel.echo',
  params: { hello: 'world' }
}
const SESSION_TOKEN = 's'.repeat(43)

function createRpcHandler(
  panelWindow: FakePanelWindow,
  outcome: PluginPanelRpcOutcome = { ok: true, value: { echoed: true } }
): { handler: (event: MessageEvent) => void; callPanelRpc: ReturnType<typeof vi.fn> } {
  const callPanelAction = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
  const callPanelRpc = vi.fn().mockResolvedValue(outcome)
  const handler = createPanelBridgeMessageHandler({
    sessionToken: SESSION_TOKEN,
    getPanelWindow: () => panelWindow,
    callPanelAction,
    callPanelRpc
  })
  return { handler, callPanelRpc }
}

describe('panel RPC renderer bridge host', () => {
  it('relays a valid RPC from the mounted window with the host session token', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler, callPanelRpc } = createRpcHandler(panelWindow)

    handler(messageEvent(VALID_RPC, panelWindow))
    await flush()

    expect(callPanelRpc).toHaveBeenCalledWith({
      sessionToken: SESSION_TOKEN,
      method: 'panel.echo',
      params: { hello: 'world' }
    })
    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      { type: 'orca-panel-rpc-result', requestId: 'rpc-1', ok: true, value: { echoed: true } },
      '*'
    )
  })

  it('ignores an RPC-shaped message from any other window', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler, callPanelRpc } = createRpcHandler(panelWindow)

    handler(messageEvent(VALID_RPC, createFakePanelWindow()))
    handler(messageEvent(VALID_RPC, null))
    await flush()

    expect(callPanelRpc).not.toHaveBeenCalled()
    expect(panelWindow.postMessage).not.toHaveBeenCalled()
  })

  it('gives iframe-supplied authority fields no effect', async () => {
    const panelWindow = createFakePanelWindow()
    const { handler, callPanelRpc } = createRpcHandler(panelWindow)

    handler(
      messageEvent(
        { ...VALID_RPC, sessionToken: 'f'.repeat(43), pluginKey: 'orca-samples.other' },
        panelWindow
      )
    )
    await flush()

    expect(callPanelRpc).not.toHaveBeenCalled()
    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-panel-rpc-result',
        requestId: 'rpc-1',
        ok: false,
        errorCode: 'invalid_request'
      }),
      '*'
    )
  })

  it('correlates two concurrent RPCs to matching request ids out of order', async () => {
    const panelWindow = createFakePanelWindow()
    let resolveFirst!: (outcome: PluginPanelRpcOutcome) => void
    let resolveSecond!: (outcome: PluginPanelRpcOutcome) => void
    const callPanelAction = vi.fn().mockResolvedValue({ ok: true, value: null })
    const callPanelRpc = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)))
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction,
      callPanelRpc
    })

    handler(messageEvent({ ...VALID_RPC, requestId: 'rpc-a' }, panelWindow))
    handler(messageEvent({ ...VALID_RPC, requestId: 'rpc-b' }, panelWindow))
    resolveSecond({ ok: true, value: { second: true } })
    await flush()
    resolveFirst({ ok: true, value: { first: true } })
    await flush()

    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      { type: 'orca-panel-rpc-result', requestId: 'rpc-b', ok: true, value: { second: true } },
      '*'
    )
    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      { type: 'orca-panel-rpc-result', requestId: 'rpc-a', ok: true, value: { first: true } },
      '*'
    )
  })

  it('drops a deferred RPC result after the panel document is replaced', async () => {
    const panelWindow = createFakePanelWindow()
    let active = true
    let resolveCall!: (outcome: PluginPanelRpcOutcome) => void
    const callPanelRpc = vi.fn(
      () => new Promise<PluginPanelRpcOutcome>((resolve) => (resolveCall = resolve))
    )
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction: vi.fn(),
      callPanelRpc,
      isActive: () => active
    })

    handler(messageEvent(VALID_RPC, panelWindow))
    active = false
    resolveCall({ ok: true, value: { stale: true } })
    await flush()

    expect(panelWindow.postMessage).not.toHaveBeenCalled()
  })

  it('answers RPC budget refusals with the RPC result type', () => {
    const panelWindow = createFakePanelWindow()
    const callPanelAction = vi.fn()
    const callPanelRpc = vi.fn()
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction,
      callPanelRpc,
      budget: { maxBytes: 1024, admit: () => 'rate_limited' }
    })

    handler(messageEvent(VALID_RPC, panelWindow))

    expect(callPanelRpc).not.toHaveBeenCalled()
    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-panel-rpc-result',
        requestId: 'rpc-1',
        ok: false,
        errorCode: 'rate_limited'
      }),
      '*'
    )
  })

  it('answers oversized RPC frames with invalid_request on the RPC result type', () => {
    const panelWindow = createFakePanelWindow()
    const callPanelAction = vi.fn()
    const callPanelRpc = vi.fn()
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction,
      callPanelRpc,
      budget: { maxBytes: 1024, admit: () => 'oversized' }
    })

    handler(messageEvent(VALID_RPC, panelWindow))

    expect(callPanelRpc).not.toHaveBeenCalled()
    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-panel-rpc-result',
        requestId: 'rpc-1',
        ok: false,
        errorCode: 'invalid_request'
      }),
      '*'
    )
  })

  it('keeps the watchdog pong path working alongside RPC traffic', async () => {
    const panelWindow = createFakePanelWindow()
    const onPong = vi.fn()
    const { handler } = createRpcHandler(panelWindow)
    const pongHandler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction: vi.fn(),
      callPanelRpc: vi.fn(),
      onPong
    })

    handler(messageEvent(VALID_RPC, panelWindow))
    pongHandler(messageEvent({ type: 'orca-panel-pong', pingId: 7 }, panelWindow))
    await flush()

    expect(onPong).toHaveBeenCalledWith(7)
  })

  it('shares one budget across alternating action and RPC calls', async () => {
    const panelWindow = createFakePanelWindow()
    const callPanelAction = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const callPanelRpc = vi.fn().mockResolvedValue({ ok: true, value: { echoed: true } })
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction,
      callPanelRpc,
      budget: createPanelMessageBudget({ maxMessages: 2, perMs: 10_000 }),
      now: () => 0
    })
    const action = {
      type: 'orca-panel-action',
      requestId: 'req-1',
      action: 'terminal.sendText',
      params: { terminalId: 'term-1', text: 'hi', enter: true }
    }

    handler(messageEvent(action, panelWindow))
    handler(messageEvent(VALID_RPC, panelWindow))
    await flush()
    expect(callPanelAction).toHaveBeenCalledTimes(1)
    expect(callPanelRpc).toHaveBeenCalledTimes(1)

    // One action plus one RPC exhausts the shared budget, so the next RPC
    // is refused even though only one prior RPC was admitted.
    handler(messageEvent({ ...VALID_RPC, requestId: 'rpc-2' }, panelWindow))
    expect(callPanelRpc).toHaveBeenCalledTimes(1)
    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-panel-rpc-result',
        requestId: 'rpc-2',
        ok: false,
        errorCode: 'rate_limited'
      }),
      '*'
    )
  })

  it('reports a rejected RPC relay call as a bounded action_failed result', async () => {
    const panelWindow = createFakePanelWindow()
    const callPanelRpc = vi.fn().mockRejectedValue(new Error('x'.repeat(20_000)))
    const handler = createPanelBridgeMessageHandler({
      sessionToken: SESSION_TOKEN,
      getPanelWindow: () => panelWindow,
      callPanelAction: vi.fn(),
      callPanelRpc
    })

    handler(messageEvent(VALID_RPC, panelWindow))
    await flush()

    expect(panelWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-panel-rpc-result',
        requestId: 'rpc-1',
        ok: false,
        errorCode: 'action_failed'
      }),
      '*'
    )
    const posted: { error?: unknown } = vi.mocked(panelWindow.postMessage).mock.calls[0]?.[0]
    expect(typeof posted.error).toBe('string')
    if (typeof posted.error === 'string') {
      expect(posted.error.length).toBeLessThanOrEqual(8192)
    }
  })
})
