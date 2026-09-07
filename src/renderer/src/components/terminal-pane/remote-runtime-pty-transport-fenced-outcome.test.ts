import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, runtimeSubscribe, subscriptionSendBinary, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle
    }
  })

describe('paired host attach evidence', () => {
  beforeEach(resetRemoteRuntimeTransport)

  it.each(['exitedBeforeAttach', 'reattachUnverifiable'] as const)(
    'carries host %s without subscribing or publishing a spawn',
    async (outcome) => {
      runtimeCall.mockImplementation(async ({ method }: { method: string }) => {
        if (method === 'terminal.resolvePane') {
          return {
            ok: false,
            error: {
              code: 'terminal_not_found',
              message: 'terminal_not_found'
            }
          }
        }
        return {
          ok: true,
          result: { terminal: { handle: 'retained-handle', [outcome]: true } }
        }
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onPtySpawn = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1',
        onPtySpawn
      })
      const result = await transport.connect({
        url: '',
        sessionId: 'remote:env-1@@retained-handle',
        callbacks: {}
      })
      expect(result).toEqual({
        id: 'remote:env-1@@retained-handle',
        [outcome]: true
      })
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.create' })
      )
      expect(runtimeSubscribe).not.toHaveBeenCalled()
      expect(onPtySpawn).not.toHaveBeenCalled()
      transport.destroy?.()
    }
  )

  it.each(['method_not_found', 'connection_unavailable'])(
    'preserves a native binding when pane resolution is %s',
    async (code) => {
      runtimeCall.mockResolvedValue({
        ok: false,
        error: { code, message: code }
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })
      const result = await transport.connect({
        url: '',
        sessionId: 'ssh:host@@pty-1',
        callbacks: {}
      })
      expect(result).toEqual({
        id: 'ssh:host@@pty-1',
        reattachUnverifiable: true
      })
      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.create' })
      )
      transport.destroy?.()
    }
  )

  it('subscribes the encoded handle when an older host lacks pane resolution', async () => {
    runtimeCall.mockResolvedValue({
      ok: false,
      error: { code: 'method_not_found', message: 'method_not_found' }
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    const result = await transport.connect({
      url: '',
      sessionId: 'remote:env-1@@terminal-1',
      callbacks: {}
    })
    expect(result).toMatchObject({ id: 'remote:env-1@@terminal-1', isReattach: true })
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
    expect(runtimeSubscribe).toHaveBeenCalled()
    transport.destroy?.()
  })

  it('adopts an encoded handle through host resolution and subscription', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    const result = await transport.connect({
      url: '',
      sessionId: 'remote:env-1@@terminal-1',
      callbacks: {}
    })
    expect(result).toMatchObject({
      id: 'remote:env-1@@terminal-1',
      isReattach: true
    })
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
    expect(runtimeSubscribe).toHaveBeenCalled()
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    transport.destroy?.()
  })
})
