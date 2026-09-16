import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processMocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('node:child_process', () => ({ fork: processMocks.fork }))

import type { PluginPanelRpcContext } from '../../shared/plugins/plugin-host-protocol'
import { startPluginWorker } from './plugin-host-process'

class FakeChild extends EventEmitter {
  connected = true
  stdout = new PassThrough()
  stderr = new PassThrough()
  send = vi.fn()
  kill = vi.fn()
}

function start(
  child: FakeChild,
  options: { eventTimeoutMs?: number; invokeTimeoutMs?: number } = {}
) {
  processMocks.fork.mockReturnValue(child)
  return startPluginWorker({
    pluginId: 'orca-samples.demo',
    rootDir: '/plugin',
    mainEntry: 'worker.js',
    entryPath: '/host.js',
    grantedCapabilities: [],
    executeHostCall: async () => ({ ok: true, value: null }),
    log: vi.fn(),
    ...options
  })
}

beforeEach(() => {
  processMocks.fork.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startPluginWorker', () => {
  it('does not inherit Orca execArgv', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [] })
    await pending

    expect(processMocks.fork).toHaveBeenCalledWith(
      '/host.js',
      [],
      expect.objectContaining({ execArgv: [] })
    )
  })

  it('replays an exit that happened before handle registration', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: ['run'] })
    const handle = await pending
    child.emit('exit', 23)
    const onExit = vi.fn()

    handle.onExit(onExit)

    expect(onExit).toHaveBeenCalledOnce()
    expect(onExit).toHaveBeenCalledWith(23)
  })

  it('kills a live worker that disconnects its IPC channel', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: ['run'] })
    const handle = await pending
    const command = handle.invokeCommand('run')
    child.connected = false

    child.emit('disconnect')

    await expect(command).rejects.toThrow('disconnected')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('counts delivered events as in flight until their acknowledgement', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [] })
    const handle = await pending

    handle.deliverEvent('worktree.created', {
      worktreeId: 'worktree-1',
      path: '/repo',
      branch: 'feature'
    })

    expect(handle.inFlightCount()).toBe(1)
    child.emit('message', { type: 'eventAck', eventId: 0 })
    expect(handle.inFlightCount()).toBe(0)
  })

  it('kills a worker whose event handler never acknowledges completion', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const pending = start(child, { eventTimeoutMs: 25 })
    child.emit('message', { type: 'ready', commands: [] })
    const handle = await pending

    handle.deliverEvent('worktree.created', {
      worktreeId: 'worktree-1',
      path: '/repo',
      branch: 'feature'
    })
    await vi.advanceTimersByTimeAsync(25)

    expect(handle.inFlightCount()).toBe(0)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills a worker that exceeds the pending event cap', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [] })
    const handle = await pending

    for (let index = 0; index < 65; index += 1) {
      handle.deliverEvent('agent.status.changed', {
        worktreeId: null,
        paneKey: `pane-${index}`,
        state: 'working',
        receivedAt: Date.now()
      })
    }

    expect(handle.inFlightCount()).toBe(64)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})

describe('startPluginWorker RPC', () => {
  async function readyRpc(child: FakeChild, rpcMethods: string[] = ['panel.echo']) {
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [], rpcMethods })
    return pending
  }

  function rpcContext(): PluginPanelRpcContext {
    return {
      panelId: 'panel',
      worktree: { worktreeId: 'wt-1', path: '/repo', branch: 'main', displayName: 'repo' },
      grantedCapabilities: []
    }
  }

  it('exposes registered RPC methods from the ready handshake', async () => {
    const child = new FakeChild()
    const handle = await readyRpc(child, ['panel.a', 'panel.b'])

    expect(handle.rpcMethods).toEqual(['panel.a', 'panel.b'])
  })

  it('resolves an RPC call with its JSON value', async () => {
    const child = new FakeChild()
    const handle = await readyRpc(child)
    child.send.mockClear()

    const result = handle.invokeRpc('panel.echo', { hello: 'world' }, rpcContext())
    const sent: { callId: number } = child.send.mock.calls[0]?.[0]
    child.emit('message', { type: 'rpcResult', callId: sent.callId, ok: true, value: { hi: 1 } })

    await expect(result).resolves.toEqual({ hi: 1 })
    expect(handle.inFlightCount()).toBe(0)
  })

  it('rejects when the worker reports a handler failure', async () => {
    const child = new FakeChild()
    const handle = await readyRpc(child)
    child.send.mockClear()

    const result = handle.invokeRpc('panel.echo', undefined, rpcContext())
    const sent: { callId: number } = child.send.mock.calls[0]?.[0]
    child.emit('message', {
      type: 'rpcResult',
      callId: sent.callId,
      ok: false,
      error: 'handler blew up'
    })

    await expect(result).rejects.toThrow('handler blew up')
  })

  it('rejects an unknown method without dispatching to the worker', async () => {
    const child = new FakeChild()
    const handle = await readyRpc(child, ['panel.known'])
    child.send.mockClear()

    await expect(handle.invokeRpc('panel.missing', undefined, rpcContext())).rejects.toThrow(
      'unknown RPC method'
    )
    expect(child.send).not.toHaveBeenCalled()
  })

  it('rejects non-JSON params without dispatching to the worker', async () => {
    const child = new FakeChild()
    const handle = await readyRpc(child)
    child.send.mockClear()

    // Why: BigInt is valid fork structured-clone data but not JSON.
    const nonJson: unknown = BigInt(1)
    await expect(handle.invokeRpc('panel.echo', nonJson, rpcContext())).rejects.toThrow(
      'JSON-compatible'
    )
    expect(child.send).not.toHaveBeenCalled()
  })

  it('correlates concurrent RPC calls to the correct results', async () => {
    const child = new FakeChild()
    const handle = await readyRpc(child, ['panel.a', 'panel.b'])
    child.send.mockClear()

    const first = handle.invokeRpc('panel.a', { n: 1 }, rpcContext())
    const second = handle.invokeRpc('panel.b', { n: 2 }, rpcContext())
    expect(handle.inFlightCount()).toBe(2)
    const firstCall = child.send.mock.calls[0]
    const secondCall = child.send.mock.calls[1]
    expect(firstCall).toBeDefined()
    expect(secondCall).toBeDefined()
    const firstId: number = firstCall![0].callId
    const secondId: number = secondCall![0].callId
    child.emit('message', { type: 'rpcResult', callId: secondId, ok: true, value: { n: 2 } })
    child.emit('message', { type: 'rpcResult', callId: firstId, ok: true, value: { n: 1 } })

    await expect(first).resolves.toEqual({ n: 1 })
    await expect(second).resolves.toEqual({ n: 2 })
    expect(handle.inFlightCount()).toBe(0)
  })

  it('times out an RPC call that never answers', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const pending = start(child, { invokeTimeoutMs: 30 })
    child.emit('message', { type: 'ready', commands: [], rpcMethods: ['panel.echo'] })
    const handle = await pending

    const result = handle.invokeRpc('panel.echo', { n: 1 }, rpcContext())
    const settled = result.then(
      () => 'resolved',
      (error: Error) => error.message
    )
    await vi.advanceTimersByTimeAsync(30)

    await expect(settled).resolves.toContain('timed out')
    expect(handle.inFlightCount()).toBe(0)
  })

  it('rejects in-flight RPC when the worker exits', async () => {
    const child = new FakeChild()
    const handle = await readyRpc(child)
    child.send.mockClear()

    const result = handle.invokeRpc('panel.echo', { n: 1 }, rpcContext())
    child.emit('exit', 1)

    await expect(result).rejects.toThrow('exited')
    expect(handle.inFlightCount()).toBe(0)
  })

  it('rejects in-flight RPC when the worker disconnects', async () => {
    const child = new FakeChild()
    const handle = await readyRpc(child)
    child.send.mockClear()

    const result = handle.invokeRpc('panel.echo', { n: 1 }, rpcContext())
    child.connected = false
    child.emit('disconnect')

    await expect(result).rejects.toThrow('disconnected')
    expect(handle.inFlightCount()).toBe(0)
  })

  it('ignores a mismatched rpcResult shape without settling the call', async () => {
    const child = new FakeChild()
    const handle = await readyRpc(child)
    child.send.mockClear()

    const result = handle.invokeRpc('panel.echo', null, rpcContext())
    const sent: { callId: number } = child.send.mock.calls[0]?.[0]
    let settled = false
    void result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    child.emit('message', { type: 'rpcResult', callId: sent.callId, ok: true, error: 'mismatched' })
    child.emit('message', { type: 'rpcResult', callId: sent.callId, ok: false, value: { n: 1 } })
    await Promise.resolve()
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(handle.inFlightCount()).toBe(1)
    child.emit('message', {
      type: 'rpcResult',
      callId: sent.callId,
      ok: true,
      value: { done: true }
    })
    await expect(result).resolves.toEqual({ done: true })
  })

  it('counts RPC as activity for idle reap', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const child = new FakeChild()
      const handle = await readyRpc(child)
      child.send.mockClear()
      const idle = handle.lastActivityAt()
      expect(idle).toBe(1_000)

      const result = handle.invokeRpc('panel.echo', undefined, rpcContext())
      expect(handle.inFlightCount()).toBe(1)
      dateNow.mockReturnValue(2_000)
      const sent: { callId: number } = child.send.mock.calls[0]?.[0]
      child.emit('message', { type: 'rpcResult', callId: sent.callId, ok: true, value: null })
      await result

      expect(handle.inFlightCount()).toBe(0)
      expect(handle.lastActivityAt()).toBe(2_000)
    } finally {
      dateNow.mockRestore()
    }
  })

  it('rejects in-flight RPC when the worker crashes', async () => {
    const child = new FakeChild()
    const handle = await readyRpc(child)
    child.send.mockClear()

    const result = handle.invokeRpc('panel.echo', { n: 1 }, rpcContext())
    child.emit('message', { type: 'fatal', error: 'worker blew up' })

    await expect(result).rejects.toThrow('worker blew up')
    expect(handle.inFlightCount()).toBe(0)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('rejects in-flight RPC when the handle is disposed', async () => {
    const child = new FakeChild()
    const handle = await readyRpc(child)
    child.send.mockClear()

    const result = handle.invokeRpc('panel.echo', { n: 1 }, rpcContext())
    const disposing = handle.dispose()
    expect(child.send).toHaveBeenCalledWith({ type: 'shutdown' })
    child.emit('exit', 0)
    await disposing

    await expect(result).rejects.toThrow('exited')
    expect(handle.inFlightCount()).toBe(0)
  })
})
