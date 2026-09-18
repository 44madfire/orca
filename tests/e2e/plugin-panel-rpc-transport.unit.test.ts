import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: the E2E in plugin-panel-rpc.unit.test.ts wires callPanelRpc straight
// to service.panels.executeRpc, so a typo or schema mismatch in the real
// preload/main binding could ship while it passes. This file closes exactly
// that gap: the REAL preload wrapper drives the REAL main handler over a
// fake transport keyed on the REAL channel name. Full Electron E2E is not
// required to prove the contract — the fake only stands in for the
// Electron IPC wire, never for either endpoint.

type FakeIpcInvokeEvent = { sender: { id: number } }
type FakeMainHandler = (event: FakeIpcInvokeEvent, args: unknown) => Promise<unknown>

const transport = vi.hoisted(() => {
  const handlers = new Map<string, FakeMainHandler>()
  const handle = vi.fn((channel: string, listener: FakeMainHandler): void => {
    handlers.set(channel, listener)
  })
  const invoke = vi.fn(async (channel: string, args: unknown): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (!handler) {
      throw new Error(`no main handler registered for channel ${channel}`)
    }
    // Mirrors Electron: the renderer cannot choose its owner — main derives
    // it from the sending webContents id (rendererPanelOwner in main).
    return handler({ sender: { id: 7 } }, args)
  })
  return { webContentsId: 7, handlers, handle, invoke }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: transport.handle,
    on: vi.fn()
  },
  ipcRenderer: {
    invoke: transport.invoke
  }
}))

import { pluginsApi } from '../../src/preload/api/plugins-bridge'
import { registerPluginHandlers } from '../../src/main/ipc/plugins'
import type { Store } from '../../src/main/persistence'
import { fingerprintPluginConsent } from '../../src/shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema, type PluginManifest } from '../../src/shared/plugins/plugin-manifest'
import {
  panelRpcCallSchema,
  type PluginPanelRpcOutcome
} from '../../src/shared/plugins/plugin-panel-bridge'
import { createPluginWorkerRuntime } from '../../src/main/plugins/plugin-host-runtime'
import type { PluginWorkerHandle } from '../../src/main/plugins/plugin-host-process'
import type { PluginWorkerFactory } from '../../src/main/plugins/plugin-worker-manager'
import { PluginService } from '../../src/main/plugins/plugin-service'

// No shared channel constant exists: the preload relay
// (src/preload/api/plugins-bridge.ts) and the main handler
// (src/main/ipc/plugins.ts) both use the 'plugins:panelRpc' string literal.
// A rename on either side breaks the assertions below by design; a matching
// typo introduced on both sides at once would not be caught — that is the
// residual risk of keeping the literals unshared.
const PANEL_RPC_CHANNEL = 'plugins:panelRpc'
const OWNER_KEY = `renderer:${transport.webContentsId}`

const roots: string[] = []
const services: PluginService[] = []

function manifestFor(): PluginManifest {
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'alpha',
    publisher: 'orca-samples',
    name: 'alpha',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    main: 'worker.js',
    contributes: {
      panels: [{ id: 'dashboard', title: 'Dashboard', entry: 'panel.html' }],
      commands: [],
      events: []
    },
    capabilities: [{ kind: 'workspace:read' }]
  })
}

async function pluginRoot(manifest: PluginManifest): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-orpc4-transport-'))
  roots.push(root)
  await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'worker.js'), 'export default async function () {}')
  await writeFile(join(root, 'panel.html'), '<h1>Panel</h1>')
  return root
}

// Why: fake fork transport — the handle speaks the real parent↔child RPC
// schema to a live plugin-host runtime without forking a real child process.
// Same register/invokeRpc shape as the E2E harness; only the observed method
// set is smaller because the transport contract needs one round trip, not
// the full security matrix.
function workerFactory(throwMessage?: string): PluginWorkerFactory {
  return async (workerOptions) => {
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
    let readyMethods: string[] = []
    let notifyReady!: () => void
    const readyPromise = new Promise<void>((resolve) => {
      notifyReady = resolve
    })
    const runtime = createPluginWorkerRuntime({
      send: (message) => {
        if (message.type === 'ready') {
          readyMethods = [...message.rpcMethods]
          notifyReady()
        } else if (message.type === 'rpcResult') {
          const entry = pending.get(message.callId)
          if (!entry) {
            return
          }
          pending.delete(message.callId)
          if (message.ok) {
            entry.resolve(message.value)
          } else {
            entry.reject(new Error(message.error))
          }
        }
      },
      importModule: async () => ({
        default: (orca: {
          rpc: { register: (method: string, handler: (params: unknown) => unknown) => void }
        }) => {
          orca.rpc.register('hello.getStatus', async (params) => {
            if (throwMessage !== undefined) {
              throw new Error(throwMessage)
            }
            return { echo: params ?? null }
          })
        }
      })
    })
    await runtime.handleMessage({
      type: 'init',
      pluginId: workerOptions.pluginId,
      pluginRoot: workerOptions.rootDir,
      mainEntry: workerOptions.mainEntry,
      grantedCapabilities: [...workerOptions.grantedCapabilities]
    })
    await readyPromise
    let nextCallId = 0
    const handle: PluginWorkerHandle = {
      commands: [],
      rpcMethods: readyMethods,
      invokeCommand: () => Promise.reject(new Error('no commands')),
      invokeRpc: (method, params, context) => {
        const callId = nextCallId++
        return new Promise<unknown>((resolve, reject) => {
          pending.set(callId, { resolve, reject })
          void runtime
            .handleMessage({
              type: 'invokeRpc',
              callId,
              method,
              ...(params === undefined ? {} : { params }),
              context
            })
            .catch((error: unknown) => {
              pending.delete(callId)
              reject(error instanceof Error ? error : new Error(String(error)))
            })
        })
      },
      deliverEvent: vi.fn(),
      lastActivityAt: () => Date.now(),
      inFlightCount: () => pending.size,
      dispose: vi.fn(async () => undefined),
      kill: vi.fn(),
      onExit: vi.fn()
    }
    return handle
  }
}

async function createTransportService(options: { throwMessage?: string } = {}): Promise<{
  service: PluginService
  sessionToken: string
}> {
  const manifest = manifestFor()
  const root = await pluginRoot(manifest)
  const service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => [],
    getPluginConsents: () => ({ 'orca-samples.alpha': fingerprintPluginConsent(manifest) }),
    getDevPluginPaths: () => [root],
    workerFactory: workerFactory(options.throwMessage)
  })
  const store = {
    onSettingsChanged: (): (() => void) => () => undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registerPluginHandlers only reads store.onSettingsChanged at registration time; the double provides exactly that member and the channel-registration assertion below proves the wiring took effect.
  registerPluginHandlers(store as unknown as Store, service, null)
  services.push(service)
  await service.initialize()
  // The owner must match the fake webContents id: the real main handler
  // derives `renderer:<sender.id>` from the transport event, never from the
  // caller-supplied payload.
  const entry = await service.panels.open(OWNER_KEY, 'orca-samples.alpha', 'dashboard')
  if (!entry) {
    throw new Error('panel failed to open')
  }
  return { service, sessionToken: entry.sessionToken }
}

beforeEach(() => {
  transport.handle.mockClear()
  transport.invoke.mockClear()
})

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ORPC-4 panel RPC preload↔main transport contract', () => {
  it('registers the production main handler on the exact production channel', async () => {
    await createTransportService()
    expect(transport.handle).toHaveBeenCalledWith(PANEL_RPC_CHANNEL, expect.any(Function))
    expect([...transport.handlers.keys()]).toContain(PANEL_RPC_CHANNEL)
  })

  it('round-trips through the real preload wrapper and real main handler with the exact envelope', async () => {
    const { service, sessionToken } = await createTransportService()
    const call = { sessionToken, method: 'hello.getStatus', params: { hello: 'panel' } }

    const viaTransport = await pluginsApi.panelRpc(call)
    const direct = await service.panels.executeRpc(OWNER_KEY, call)

    // The preload relay must add nothing, rename nothing, and reshape
    // nothing: toEqual is exact on own enumerable keys, so an extra field
    // (pluginKey, panelId, worktree, token) or a renamed field fails here.
    expect(transport.invoke).toHaveBeenCalledTimes(1)
    expect(transport.invoke).toHaveBeenCalledWith(PANEL_RPC_CHANNEL, call)
    const sent = transport.invoke.mock.calls[0]?.[1]
    expect(sent).toEqual({ sessionToken, method: 'hello.getStatus', params: { hello: 'panel' } })
    expect(panelRpcCallSchema.safeParse(sent).success).toBe(true)
    // The main result must come back unchanged through the relay.
    expect(viaTransport).toEqual(direct)
    expect(viaTransport).toEqual({ ok: true, value: { echo: { hello: 'panel' } } })
  })

  it('forwards the bounded failure shapes unchanged (unknown_method)', async () => {
    const { service, sessionToken } = await createTransportService()
    const call = { sessionToken, method: 'hello.missing' }

    const viaTransport: PluginPanelRpcOutcome = await pluginsApi.panelRpc(call)
    const direct = await service.panels.executeRpc(OWNER_KEY, call)

    expect(transport.invoke).toHaveBeenCalledWith(PANEL_RPC_CHANNEL, call)
    expect(viaTransport).toEqual(direct)
    expect(viaTransport).toMatchObject({ ok: false, code: 'unknown_method' })
  })

  it('forwards the bounded failure shapes unchanged (action_failed stays within the error cap)', async () => {
    const { service, sessionToken } = await createTransportService({
      throwMessage: `boom-${'x'.repeat(9000)}`
    })
    const call = { sessionToken, method: 'hello.getStatus' }

    const viaTransport: PluginPanelRpcOutcome = await pluginsApi.panelRpc(call)
    const direct = await service.panels.executeRpc(OWNER_KEY, call)

    expect(viaTransport).toEqual(direct)
    if (viaTransport.ok) {
      throw new Error('expected the throwing worker to fail the panel RPC')
    }
    // String-based codes: no typed-provenance failure kinds exist on this
    // base — the ORPC-1 typed-provenance fix flows down on the next stack
    // rebase, at which point this pins the typed code instead.
    expect(viaTransport.code).toBe('action_failed')
    expect(viaTransport.error.length).toBeLessThanOrEqual(8192)
  })
})
