import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processMocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('node:child_process', () => ({ fork: processMocks.fork }))

import {
  PLUGIN_WORKER_RPC_RESULT_MAX_BYTES,
  type PluginPanelRpcContext,
  type PluginWorkerParentMessage,
  type PluginWorkerRpcResult
} from '../../shared/plugins/plugin-host-protocol'
import { startPluginWorker } from './plugin-host-process'
import { PluginWorkerRpcCalls } from './plugin-worker-rpc-calls'
import {
  PluginWorkerRpcError,
  mapPluginWorkerRpcErrorToOutcome,
  pluginWorkerRpcFailureKindOf,
  pluginWorkerRpcOutcomeCodeForKind,
  wrapPluginWorkerStartupFailure
} from './plugin-worker-rpc-failure'
import { createPluginWorkerRuntime, type PluginWorkerOrcaApi } from './plugin-host-runtime'

function rpcContext(): PluginPanelRpcContext {
  return { panelId: 'panel', worktree: null, grantedCapabilities: [] }
}

function trackCalls(tag = '[plugin:orca-samples.demo]'): {
  calls: PluginWorkerRpcCalls
  send: ReturnType<typeof vi.fn>
} {
  const send = vi.fn()
  const calls = new PluginWorkerRpcCalls(tag, 30_000, send, () => undefined)
  calls.setMethods(['panel.echo'])
  return { calls, send }
}

// Rejects with the tagged error object instead of throwing its message, so
// tests can assert on the failure kind.
async function invokeFailure(
  calls: PluginWorkerRpcCalls,
  send: ReturnType<typeof vi.fn>,
  method = 'panel.echo'
): Promise<{ callId: number; failure: Promise<unknown> }> {
  const pending = calls.invoke(method, { n: 1 }, rpcContext())
  const sent: { callId: number } = send.mock.calls.at(-1)?.[0]
  const failure = pending.then(
    () => null,
    (error: unknown) => error
  )
  return { callId: sent.callId, failure }
}

describe('typed RPC failure provenance', () => {
  it.each([
    'operation timed out while fetching upstream',
    'worker exited unexpectedly during render',
    'renderer crashed while painting',
    'unknown RPC method panel.other',
    'timed out, exited, crashed, disconnected, unknown RPC method'
  ])('maps handler text %j to handler_failure, never a lifecycle kind', async (text) => {
    const { calls, send } = trackCalls()
    const { callId, failure } = await invokeFailure(calls, send)
    const refusal: PluginWorkerRpcResult = {
      type: 'rpcResult',
      callId,
      ok: false,
      error: text
    }

    expect(calls.handleResult(refusal)).toBe(true)

    const error = await failure
    expect(error).toBeInstanceOf(PluginWorkerRpcError)
    expect(pluginWorkerRpcFailureKindOf(error)).toBe('handler_failure')
    expect(mapPluginWorkerRpcErrorToOutcome(error)).toMatchObject({
      ok: false,
      code: 'action_failed'
    })
    expect(calls.inFlightCount()).toBe(0)
  })

  it('produces the timeout kind when the worker never answers', async () => {
    vi.useFakeTimers()
    try {
      const { calls, send } = trackCalls()
      const pending = calls.invoke('panel.echo', { n: 1 }, rpcContext())
      expect(send).toHaveBeenCalledOnce()
      const failure = pending.then(
        () => null,
        (error: unknown) => error
      )
      await vi.advanceTimersByTimeAsync(30_000)

      const error = await failure
      expect(pluginWorkerRpcFailureKindOf(error)).toBe('timeout')
      expect(mapPluginWorkerRpcErrorToOutcome(error)).toMatchObject({
        ok: false,
        code: 'unavailable'
      })
      expect(calls.inFlightCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('produces unknown_method without dispatching to the worker', async () => {
    const { calls, send } = trackCalls()
    const failure = calls.invoke('panel.missing', null, rpcContext()).then(
      () => null,
      (error: unknown) => error
    )

    const error = await failure
    expect(pluginWorkerRpcFailureKindOf(error)).toBe('unknown_method')
    expect(mapPluginWorkerRpcErrorToOutcome(error)).toMatchObject({
      ok: false,
      code: 'unknown_method'
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('produces invalid_request for non-JSON params and malformed envelopes', async () => {
    const { calls, send } = trackCalls()
    // Why BigInt: valid fork structured-clone data but not JSON.
    const nonJson = calls.invoke('panel.echo', BigInt(1), rpcContext()).then(
      () => null,
      (error: unknown) => error
    )
    expect(pluginWorkerRpcFailureKindOf(await nonJson)).toBe('invalid_request')

    const malformed = calls
      .invoke('panel.echo', null, {
        panelId: '',
        worktree: null,
        grantedCapabilities: []
      })
      .then(
        () => null,
        (error: unknown) => error
      )
    const error = await malformed
    expect(pluginWorkerRpcFailureKindOf(error)).toBe('invalid_request')
    expect(mapPluginWorkerRpcErrorToOutcome(error)).toMatchObject({
      ok: false,
      code: 'invalid_request'
    })
    expect(send).not.toHaveBeenCalled()
    expect(calls.inFlightCount()).toBe(0)
  })

  it.each([
    ['worker_exit', 'worker exited before responding'],
    ['disconnect', 'worker disconnected before responding'],
    ['worker_crash', 'worker crashed: boom']
  ] as const)('rejects in-flight calls with the %s kind', async (kind, reason) => {
    const { calls, send } = trackCalls()
    const { failure } = await invokeFailure(calls, send)

    calls.rejectAll(`[plugin:orca-samples.demo] ${reason}`, kind)

    const error = await failure
    expect(pluginWorkerRpcFailureKindOf(error)).toBe(kind)
    expect(mapPluginWorkerRpcErrorToOutcome(error)).toMatchObject({
      ok: false,
      code: 'unavailable'
    })
    expect(calls.inFlightCount()).toBe(0)
  })

  it('branches on kind, never on message text', () => {
    const text = 'operation timed out after 30000ms'
    expect(pluginWorkerRpcOutcomeCodeForKind('timeout')).toBe('unavailable')
    expect(
      mapPluginWorkerRpcErrorToOutcome(new PluginWorkerRpcError('timeout', text))
    ).toMatchObject({ code: 'unavailable' })
    expect(
      mapPluginWorkerRpcErrorToOutcome(new PluginWorkerRpcError('handler_failure', text))
    ).toMatchObject({ code: 'action_failed' })
  })

  it('maps untagged spawn/ensure failures to unavailable', () => {
    expect(mapPluginWorkerRpcErrorToOutcome(new Error('spawn ENOENT'))).toMatchObject({
      ok: false,
      code: 'unavailable'
    })
    const wrapped = wrapPluginWorkerStartupFailure('orca-samples.demo')
    expect(pluginWorkerRpcFailureKindOf(wrapped)).toBe('worker_unavailable')
    expect(mapPluginWorkerRpcErrorToOutcome(wrapped)).toEqual({
      ok: false,
      code: 'unavailable',
      error: 'plugin orca-samples.demo worker is not available'
    })
  })

  it('bounds outcome error text regardless of handler verbosity', () => {
    const error = new PluginWorkerRpcError('handler_failure', 'x'.repeat(9000))
    const outcome = mapPluginWorkerRpcErrorToOutcome(error)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.length).toBeLessThanOrEqual(2048)
    }
  })
})

class FakeChild extends EventEmitter {
  connected = true
  stdout = new PassThrough()
  stderr = new PassThrough()
  send = vi.fn()
  kill = vi.fn()
}

describe('worker handle RPC failure kinds', () => {
  beforeEach(() => {
    processMocks.fork.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function readyHandle(child: FakeChild, invokeTimeoutMs = 30_000) {
    processMocks.fork.mockReturnValue(child)
    const pending = startPluginWorker({
      pluginId: 'orca-samples.demo',
      rootDir: '/plugin',
      mainEntry: 'worker.js',
      entryPath: '/host.js',
      grantedCapabilities: [],
      executeHostCall: async () => ({ ok: true, value: null }),
      log: vi.fn(),
      invokeTimeoutMs
    })
    child.emit('message', { type: 'ready', commands: [], rpcMethods: ['panel.echo'] })
    return pending
  }

  async function invokeKind(
    emit: (child: FakeChild, callId: number) => void,
    invokeTimeoutMs = 30_000
  ): Promise<unknown> {
    const child = new FakeChild()
    const handle = await readyHandle(child, invokeTimeoutMs)
    child.send.mockClear()
    const pending = handle.invokeRpc('panel.echo', { n: 1 }, rpcContext())
    const sent: { callId: number } = child.send.mock.calls[0]?.[0]
    const failure = pending.then(
      () => null,
      (error: unknown) => error
    )
    emit(child, sent.callId)
    return failure
  }

  it('carries handler_failure across the handle boundary', async () => {
    const error = await invokeKind((child, callId) => {
      child.emit('message', {
        type: 'rpcResult',
        callId,
        ok: false,
        error: 'operation timed out while fetching upstream'
      })
    })

    expect(pluginWorkerRpcFailureKindOf(error)).toBe('handler_failure')
  })

  it('carries worker_exit when the worker exits mid-call', async () => {
    const child = new FakeChild()
    const handle = await readyHandle(child)
    child.send.mockClear()
    const pending = handle.invokeRpc('panel.echo', { n: 1 }, rpcContext())
    const failure = pending.then(
      () => null,
      (error: unknown) => error
    )
    child.emit('exit', 1)

    expect(pluginWorkerRpcFailureKindOf(await failure)).toBe('worker_exit')
    expect(handle.inFlightCount()).toBe(0)
  })

  it('carries disconnect when the IPC channel drops', async () => {
    const child = new FakeChild()
    const handle = await readyHandle(child)
    child.send.mockClear()
    const pending = handle.invokeRpc('panel.echo', { n: 1 }, rpcContext())
    const failure = pending.then(
      () => null,
      (error: unknown) => error
    )
    child.connected = false
    child.emit('disconnect')

    expect(pluginWorkerRpcFailureKindOf(await failure)).toBe('disconnect')
    expect(handle.inFlightCount()).toBe(0)
  })

  it('carries worker_crash on a fatal worker message', async () => {
    const child = new FakeChild()
    const handle = await readyHandle(child)
    child.send.mockClear()
    const pending = handle.invokeRpc('panel.echo', { n: 1 }, rpcContext())
    const failure = pending.then(
      () => null,
      (error: unknown) => error
    )
    child.emit('message', { type: 'fatal', error: 'worker blew up' })

    expect(pluginWorkerRpcFailureKindOf(await failure)).toBe('worker_crash')
    expect(handle.inFlightCount()).toBe(0)
  })

  it('carries timeout across the handle boundary', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    processMocks.fork.mockReturnValue(child)
    const pendingHandle = startPluginWorker({
      pluginId: 'orca-samples.demo',
      rootDir: '/plugin',
      mainEntry: 'worker.js',
      entryPath: '/host.js',
      grantedCapabilities: [],
      executeHostCall: async () => ({ ok: true, value: null }),
      log: vi.fn(),
      invokeTimeoutMs: 30
    })
    child.emit('message', { type: 'ready', commands: [], rpcMethods: ['panel.echo'] })
    const handle = await pendingHandle
    const pending = handle.invokeRpc('panel.echo', { n: 1 }, rpcContext())
    const failure = pending.then(
      () => null,
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(30)

    expect(pluginWorkerRpcFailureKindOf(await failure)).toBe('timeout')
    expect(handle.inFlightCount()).toBe(0)
  })

  it('rejects calls after exit with worker_exit', async () => {
    const child = new FakeChild()
    const handle = await readyHandle(child)
    child.emit('exit', 1)

    const error = await handle.invokeRpc('panel.echo', null, rpcContext()).then(
      () => null,
      (failure: unknown) => failure
    )
    expect(pluginWorkerRpcFailureKindOf(error)).toBe('worker_exit')
  })

  it('rejects unknown methods via the handle with unknown_method', async () => {
    const child = new FakeChild()
    const handle = await readyHandle(child)

    const error = await handle.invokeRpc('panel.missing', null, rpcContext()).then(
      () => null,
      (failure: unknown) => failure
    )
    expect(pluginWorkerRpcFailureKindOf(error)).toBe('unknown_method')
  })
})

describe('serialized RPC result-size bound', () => {
  async function initWith(activate: (orca: PluginWorkerOrcaApi) => unknown) {
    const send = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      exit: vi.fn(),
      importModule: async () => ({ default: activate })
    })
    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'worker.js',
      grantedCapabilities: []
    })
    return { runtime, send }
  }

  function payloadOverhead(): number {
    return Buffer.byteLength(JSON.stringify({ data: '' }), 'utf8')
  }

  it('passes a result just under the serialized limit', async () => {
    const size = PLUGIN_WORKER_RPC_RESULT_MAX_BYTES - payloadOverhead()
    const { runtime, send } = await initWith((orca) => {
      orca.rpc.register('panel.big', () => ({ data: 'x'.repeat(size) }))
    })
    send.mockClear()

    await runtime.handleMessage({
      type: 'invokeRpc',
      callId: 1,
      method: 'panel.big',
      context: rpcContext()
    })

    const result: { ok?: boolean } = send.mock.calls[0]?.[0]
    expect(result.ok).toBe(true)
  })

  it('rejects a result just over the limit with a bounded error', async () => {
    const size = PLUGIN_WORKER_RPC_RESULT_MAX_BYTES - payloadOverhead() + 1
    const { runtime, send } = await initWith((orca) => {
      orca.rpc.register('panel.big', () => ({ data: 'x'.repeat(size) }))
    })
    send.mockClear()

    await runtime.handleMessage({
      type: 'invokeRpc',
      callId: 2,
      method: 'panel.big',
      context: rpcContext()
    })

    const result: { ok?: boolean; error?: string } = send.mock.calls[0]?.[0]
    expect(result.ok).toBe(false)
    expect(result.error).toContain('exceeds')
    expect(result.error!.length).toBeLessThanOrEqual(512)
  })

  it('enforces the limit for large array shapes', async () => {
    const { runtime, send } = await initWith((orca) => {
      orca.rpc.register('panel.rows', () => Array.from({ length: 20_000 }, () => 'row-value'))
    })
    send.mockClear()

    await runtime.handleMessage({
      type: 'invokeRpc',
      callId: 3,
      method: 'panel.rows',
      context: rpcContext()
    })

    const result: { ok?: boolean; error?: string } = send.mock.calls[0]?.[0]
    expect(result.ok).toBe(false)
    expect(result.error).toContain('exceeds')
  })

  it('settles the parent pending call as handler_failure instead of hanging', async () => {
    const size = PLUGIN_WORKER_RPC_RESULT_MAX_BYTES - payloadOverhead() + 1
    const { runtime, send } = await initWith((orca) => {
      orca.rpc.register('panel.big', () => ({ data: 'x'.repeat(size) }))
    })
    send.mockClear()
    await runtime.handleMessage({
      type: 'invokeRpc',
      callId: 9,
      method: 'panel.big',
      context: rpcContext()
    })
    const refusal: { callId: number; ok: boolean; error: string } = send.mock.calls[0]?.[0]

    // Why: the refused callId belongs to the child-side envelope; re-target
    // the refusal at a parent-side pending call to prove the refusal shape
    // settles it instead of hanging until the invoke timeout.
    const parentSend: { callId: number }[] = []
    const parentCalls = new PluginWorkerRpcCalls(
      '[plugin:orca-samples.demo]',
      30_000,
      (message: PluginWorkerParentMessage) => {
        if ('callId' in message) {
          parentSend.push({ callId: message.callId })
        }
      },
      () => undefined
    )
    parentCalls.setMethods(['panel.big'])
    const settled = parentCalls.invoke('panel.big', undefined, rpcContext()).then(
      () => null,
      (error: unknown) => error
    )
    const retargeted: PluginWorkerRpcResult = {
      type: 'rpcResult',
      callId: parentSend[0]?.callId ?? -1,
      ok: false,
      error: refusal.error
    }
    expect(parentCalls.handleResult(retargeted)).toBe(true)

    const error = await settled
    expect(pluginWorkerRpcFailureKindOf(error)).toBe('handler_failure')
    expect(parentCalls.inFlightCount()).toBe(0)
  })

  it('measures serialized UTF-8 bytes, matching the service response convention', () => {
    // Why ascii fixtures: 1 char == 1 UTF-8 byte, so the boundary is exact.
    const atLimit = JSON.stringify({ data: 'x'.repeat(64 * 1024 - payloadOverhead()) })
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(PLUGIN_WORKER_RPC_RESULT_MAX_BYTES)
    expect(PLUGIN_WORKER_RPC_RESULT_MAX_BYTES).toBe(64 * 1024)
  })
})
