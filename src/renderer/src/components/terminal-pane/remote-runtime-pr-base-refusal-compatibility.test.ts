import { resolve } from 'node:path'
import { TERMINAL_FENCED_CREATE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { loadPrBasePtyTransport } from './pr-base-pty-transport-test-loader'
import { beforeEach, it, expect, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
let callbacks: MultiplexSubscriptionCallbacks = null
let handle = 'terminal-1'
const { runtimeCall, runtimeSubscribe, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => callbacks,
    setCallbacks: (c) => {
      callbacks = c
    },
    getResolvedPaneHandle: () => handle,
    setResolvedPaneHandle: (h) => {
      handle = h
    }
  })
beforeEach(resetRemoteRuntimeTransport)

it.each([
  ['old', 'exitedBeforeAttach'],
  ['old', 'reattachUnverifiable'],
  ['current', 'exitedBeforeAttach'],
  ['current', 'reattachUnverifiable']
] as const)('%s client preserves host %s refusal without a fake spawn', async (reader, outcome) => {
  const hostPath = resolve(__dirname, '../../../../main/runtime')
  const { terminalAttachRefusal } = await import(`${hostPath}/terminal-attach-refusal`)
  const { mapRuntimeError } = await import(`${hostPath}/rpc/errors`)
  const { TERMINAL_LIFECYCLE_METHODS } = await import(
    `${hostPath}/rpc/methods/terminal/terminal-lifecycle-methods`
  )
  const refused = terminalAttachRefusal(
    { id: 'old-worker-pty', [outcome]: true },
    {
      handle: 'unpublished-refusal-handle',
      tabId: 'tab-1',
      paneKey: 'tab-1:5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b',
      worktreeId: 'wt-1'
    }
  )!
  runtimeCall.mockImplementation(
    async ({ method, params }: { method: string; params: unknown }) => {
      if (method === 'terminal.resolvePane') {
        return { ok: false, error: { code: 'terminal_not_found', message: 'terminal_not_found' } }
      }
      if (method === 'status.get') {
        return { ok: true, result: { capabilities: ['terminal.fenced-create.v1'] } }
      }
      if (method === 'terminal.create') {
        const definition = TERMINAL_LIFECYCLE_METHODS.find(
          (m: { name: string }) => m.name === 'terminal.create'
        )!
        try {
          const result = await definition.handler(params, {
            clientKind: 'runtime',
            clientCapabilities: reader === 'old' ? [] : [TERMINAL_FENCED_CREATE_RUNTIME_CAPABILITY],
            runtime: {
              dedupeTerminalCreate: async (
                _client: string,
                wt: string,
                _id: unknown,
                _reconcile: boolean,
                create: (worktree: string, handle: string) => Promise<unknown>
              ) => create(wt, 'unpublished-refusal-handle'),
              createTerminal: async () => refused
            }
          } as never)
          return { ok: true, result }
        } catch (error) {
          return mapRuntimeError('request', { runtimeId: 'host' }, error)
        }
      }
      return { ok: true, result: {} }
    }
  )
  const { createRemoteRuntimePtyTransport } =
    reader === 'old'
      ? await loadPrBasePtyTransport()
      : await import('./remote-runtime-pty-transport')
  const onPtySpawn = vi.fn()
  const onExit = vi.fn()
  const onError = vi.fn()
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b',
    onPtySpawn
  })
  try {
    const result = await transport.connect({
      url: '',
      sessionId: 'remote:env-1@@retained-handle',
      callbacks: { onExit, onError }
    })
    expect(runtimeCall).toHaveBeenCalledWith(expect.objectContaining({ method: 'terminal.create' }))
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    if (reader === 'old') {
      expect(result).toBeUndefined()
      expect(transport.getRecoveryState?.()).toMatchObject({ phase: 'disconnected' })
    } else {
      expect(result).toEqual({ id: 'remote:env-1@@retained-handle', [outcome]: true })
    }
    expect(runtimeSubscribe).not.toHaveBeenCalled()
  } finally {
    transport.destroy?.()
  }
})
