import { afterEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext, type RpcMethod } from '../core'
import type { PluginService } from '../../../plugins/plugin-service'
import { PLUGIN_METHODS, setPluginServiceForRpc } from './plugins'

const SESSION_TOKEN = 's'.repeat(43)

function method(name: string): RpcMethod {
  const found = eraseRpcMethods(PLUGIN_METHODS).find((entry) => entry.name === name)
  if (!found) {
    throw new Error(`missing ${name}`)
  }
  if ('stream' in found) {
    throw new Error(`${name} is streaming`)
  }
  return found
}

function context(connectionId?: string): RpcContext {
  return { runtime: {} as RpcContext['runtime'], connectionId, clientId: 'paired-device' }
}

afterEach(() => setPluginServiceForRpc(null))

describe('plugin panel serve RPC identity', () => {
  it('leaves the raw panel envelope for session resolution and admission', () => {
    const schema = method('plugins.panelAction').params!

    expect(
      schema.safeParse({
        pluginId: 'orca-samples.other',
        unexpected: 'x'.repeat(100_000)
      }).success
    ).toBe(true)
  })

  it('binds panel loading and actions to the same runtime connection owner', async () => {
    const service = {
      whenReady: vi.fn().mockResolvedValue(undefined),
      panels: {
        open: vi.fn().mockResolvedValue({ html: '<p>panel</p>', sessionToken: SESSION_TOKEN }),
        execute: vi.fn().mockResolvedValue({ ok: true, value: { branch: 'main' } }),
        bindOwnerSignal: vi.fn(),
        revokeOwner: vi.fn()
      }
    } as unknown as PluginService
    setPluginServiceForRpc(service)
    const rpcContext = context('connection-one')

    await expect(
      method('plugins.readPanelEntry').handler(
        { pluginKey: 'orca-samples.demo', panelId: 'dashboard' },
        rpcContext
      )
    ).resolves.toEqual({ html: '<p>panel</p>', sessionToken: SESSION_TOKEN })
    expect(service.panels.open).toHaveBeenCalledWith(
      'runtime:connection-one',
      'orca-samples.demo',
      'dashboard'
    )

    await expect(
      method('plugins.panelAction').handler(
        { sessionToken: SESSION_TOKEN, action: 'workspace.readContext', params: {} },
        rpcContext
      )
    ).resolves.toEqual({ outcome: { ok: true, value: { branch: 'main' } } })
    expect(service.panels.execute).toHaveBeenCalledWith('runtime:connection-one', {
      sessionToken: SESSION_TOKEN,
      action: 'workspace.readContext',
      params: {}
    })
  })

  it('routes panel RPC through the same session-bound owner without a plugin target', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the panelRpc handler reaches only whenReady, panels.bindOwnerSignal, and panels.executeRpc; the double stubs exactly those members and the test asserts the relayed call, so an omitted member throws rather than reading a wrong value.
    const service = {
      whenReady: vi.fn().mockResolvedValue(undefined),
      panels: {
        open: vi.fn(),
        execute: vi.fn(),
        executeRpc: vi.fn().mockResolvedValue({ ok: true, value: { echoed: true } }),
        bindOwnerSignal: vi.fn(),
        revokeOwner: vi.fn()
      }
    } as unknown as PluginService
    setPluginServiceForRpc(service)
    const rpcContext = context('connection-one')

    await expect(
      method('plugins.panelRpc').handler(
        { sessionToken: SESSION_TOKEN, method: 'panel.echo', params: { n: 1 } },
        rpcContext
      )
    ).resolves.toEqual({ outcome: { ok: true, value: { echoed: true } } })
    expect(service.panels.executeRpc).toHaveBeenCalledWith('runtime:connection-one', {
      sessionToken: SESSION_TOKEN,
      method: 'panel.echo',
      params: { n: 1 }
    })
  })
})
