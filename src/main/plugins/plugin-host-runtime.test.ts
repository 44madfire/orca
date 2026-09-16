import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginPanelRpcContext } from '../../shared/plugins/plugin-host-protocol'
import { createPluginWorkerRuntime, type PluginWorkerOrcaApi } from './plugin-host-runtime'

describe('plugin worker shutdown', () => {
  it('normalizes either manifest separator before importing the worker', async () => {
    const importModule = vi.fn(async () => ({ default: vi.fn() }))
    const runtime = createPluginWorkerRuntime({ send: vi.fn(), importModule })

    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: join('plugin-root'),
      mainEntry: 'nested\\worker.js',
      grantedCapabilities: []
    })

    expect(importModule).toHaveBeenCalledWith(
      pathToFileURL(join('plugin-root', 'nested', 'worker.js')).href
    )
  })

  it('awaits an optional deactivate export before exiting', async () => {
    let finishDeactivate!: () => void
    const deactivate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDeactivate = resolve
        })
    )
    const send = vi.fn()
    const exit = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      exit,
      importModule: async () => ({ default: vi.fn(), deactivate })
    })
    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'worker.js',
      grantedCapabilities: []
    })

    const shutdown = runtime.handleMessage({ type: 'shutdown' })
    await Promise.resolve()
    expect(deactivate).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
    finishDeactivate()
    await shutdown

    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits immediately when the plugin has no deactivate export', async () => {
    const exit = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send: vi.fn(),
      exit,
      importModule: async () => ({ default: vi.fn() })
    })
    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'worker.js',
      grantedCapabilities: []
    })

    await runtime.handleMessage({ type: 'shutdown' })

    expect(exit).toHaveBeenCalledWith(0)
  })
})

describe('plugin worker private RPC', () => {
  async function initWith(activate: (orca: PluginWorkerOrcaApi) => unknown) {
    const send = vi.fn()
    const exit = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      exit,
      importModule: async () => ({ default: activate })
    })
    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'worker.js',
      grantedCapabilities: []
    })
    return { runtime, send, exit }
  }

  function rpcContext(): PluginPanelRpcContext {
    return {
      panelId: 'panel',
      worktree: { worktreeId: 'wt-1', path: '/repo', branch: 'main', displayName: 'repo' },
      grantedCapabilities: []
    }
  }

  it('reports registered RPC methods in the ready handshake', async () => {
    const { send } = await initWith((orca) => {
      orca.rpc.register('panel.echo', (params) => params)
    })

    expect(send).toHaveBeenCalledWith({
      type: 'ready',
      commands: [],
      rpcMethods: ['panel.echo']
    })
  })

  it('fails activation deterministically on duplicate RPC registration', async () => {
    const { send, exit } = await initWith((orca) => {
      orca.rpc.register('panel.echo', () => null)
      orca.rpc.register('panel.echo', () => null)
    })

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fatal', error: expect.stringContaining('duplicate') })
    )
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('fails activation on an invalid RPC method id', async () => {
    const { send, exit } = await initWith((orca) => {
      orca.rpc.register('not a method!', () => null)
    })

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fatal', error: expect.stringContaining('invalid RPC') })
    )
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('invokes a registered handler and returns its JSON value', async () => {
    const { runtime, send } = await initWith((orca) => {
      orca.rpc.register('panel.sum', (params) => {
        const input = z.object({ values: z.array(z.number()) }).parse(params)
        return { total: input.values.reduce((a, b) => a + b, 0) }
      })
    })
    send.mockClear()

    await runtime.handleMessage({
      type: 'invokeRpc',
      callId: 7,
      method: 'panel.sum',
      params: { values: [1, 2, 3] },
      context: rpcContext()
    })

    expect(send).toHaveBeenCalledWith({
      type: 'rpcResult',
      callId: 7,
      ok: true,
      value: { total: 6 }
    })
  })

  it('returns a bounded error when the handler throws', async () => {
    const { runtime, send } = await initWith((orca) => {
      orca.rpc.register('panel.boom', () => {
        throw new Error('handler blew up')
      })
    })
    send.mockClear()

    await runtime.handleMessage({
      type: 'invokeRpc',
      callId: 1,
      method: 'panel.boom',
      context: rpcContext()
    })

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rpcResult', callId: 1, ok: false })
    )
    const result: { error?: string } = send.mock.calls[0]?.[0]
    expect(result.error).toContain('handler blew up')
    expect(result.error!.length).toBeLessThanOrEqual(8192)
  })

  it('refuses an unknown method without running any handler', async () => {
    const handler = vi.fn(() => null)
    const { runtime, send } = await initWith((orca) => {
      orca.rpc.register('panel.known', handler)
    })
    send.mockClear()

    await runtime.handleMessage({
      type: 'invokeRpc',
      callId: 3,
      method: 'panel.missing',
      context: rpcContext()
    })

    expect(handler).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith({
      type: 'rpcResult',
      callId: 3,
      ok: false,
      error: 'unknown RPC method panel.missing'
    })
  })

  it('rejects a non-JSON handler result as a failure', async () => {
    const { runtime, send } = await initWith((orca) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture returns non-JSON to prove the boundary rejects it.
      orca.rpc.register('panel.bad', () => BigInt(1) as unknown)
    })
    send.mockClear()

    await runtime.handleMessage({
      type: 'invokeRpc',
      callId: 4,
      method: 'panel.bad',
      context: rpcContext()
    })

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rpcResult', callId: 4, ok: false })
    )
  })

  it('ignores a malformed RPC envelope without replying', async () => {
    const { runtime, send } = await initWith((orca) => {
      orca.rpc.register('panel.echo', (params) => params)
    })
    send.mockClear()

    await runtime.handleMessage({
      type: 'invokeRpc',
      callId: 5,
      method: 'bad id!',
      context: rpcContext()
    })

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'log', level: 'warn' }))
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rpcResult' }))
  })

  it('passes the validated context to the handler as the second argument', async () => {
    const seen: unknown[] = []
    const { runtime, send } = await initWith((orca) => {
      orca.rpc.register('panel.echo', (params, context) => {
        seen.push(context)
        return params
      })
    })
    send.mockClear()
    const context = {
      panelId: 'panel',
      worktree: { worktreeId: 'wt-9', path: '/other', branch: 'dev', displayName: 'other' },
      grantedCapabilities: []
    } as const

    await runtime.handleMessage({
      type: 'invokeRpc',
      callId: 11,
      method: 'panel.echo',
      params: { a: 1 },
      context: { ...context, grantedCapabilities: [...context.grantedCapabilities] }
    })

    expect(send).toHaveBeenCalledWith({
      type: 'rpcResult',
      callId: 11,
      ok: true,
      value: { a: 1 }
    })
    expect(seen).toEqual([context])
  })

  it('ignores an RPC envelope missing its context without replying', async () => {
    const { runtime, send } = await initWith((orca) => {
      orca.rpc.register('panel.echo', (params) => params)
    })
    send.mockClear()

    await runtime.handleMessage({ type: 'invokeRpc', callId: 6, method: 'panel.echo' })

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'log', level: 'warn' }))
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rpcResult' }))
  })

  it('accepts empty branch and displayName from host-constructed context', async () => {
    const { runtime, send } = await initWith((orca) => {
      orca.rpc.register('panel.echo', (params) => params)
    })
    send.mockClear()

    await runtime.handleMessage({
      type: 'invokeRpc',
      callId: 12,
      method: 'panel.echo',
      params: null,
      context: {
        panelId: 'panel',
        worktree: { worktreeId: 'wt-1', path: '/repo', branch: '', displayName: '' },
        grantedCapabilities: []
      }
    })

    expect(send).toHaveBeenCalledWith({
      type: 'rpcResult',
      callId: 12,
      ok: true,
      value: null
    })
  })

  it('preserves registration order across multiple RPC methods', async () => {
    const { send } = await initWith((orca) => {
      orca.rpc.register('panel.zeta', () => null)
      orca.rpc.register('panel.alpha', () => null)
      orca.rpc.register('panel.mid', () => null)
    })

    expect(send).toHaveBeenCalledWith({
      type: 'ready',
      commands: [],
      rpcMethods: ['panel.zeta', 'panel.alpha', 'panel.mid']
    })
  })

  it('reports an empty method list when nothing is registered', async () => {
    const { send } = await initWith(() => {})

    expect(send).toHaveBeenCalledWith({ type: 'ready', commands: [], rpcMethods: [] })
  })

  it('keeps commands working when RPC methods are registered', async () => {
    const { runtime, send } = await initWith((orca) => {
      orca.commands.register('run', () => ({ ok: true }))
      orca.rpc.register('panel.echo', (params) => params)
    })
    send.mockClear()

    await runtime.handleMessage({ type: 'invokeCommand', callId: 9, commandId: 'run' })

    expect(send).toHaveBeenCalledWith({
      type: 'commandResult',
      callId: 9,
      ok: true,
      value: { ok: true }
    })
  })
})
