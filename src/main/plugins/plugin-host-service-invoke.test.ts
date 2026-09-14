import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_SERVICE_REQUEST_MAX_BYTES,
  PLUGIN_SERVICE_RESPONSE_MAX_BYTES
} from '../../shared/plugins/plugin-host-api'
import {
  collectGrantedServiceIds,
  type PluginCapability
} from '../../shared/plugins/plugin-capabilities'
import { gatePluginHostCall } from '../../shared/plugins/plugin-capability-gate'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { emptyPluginLockfile } from '../../shared/plugins/plugin-install-lockfile'
import { parsePluginManifest, pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { bindPluginHostServices } from './plugin-host-service-bindings'
import { buildPluginList } from './plugin-list-projection'
import { hashPluginTree } from './plugin-content-hash'
import { PluginService } from './plugin-service'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'

const PLUGIN_KEY = 'orca-samples.demo'
const SERVICE_ID = 'orca-pi.bridge'
const OTHER_SERVICE_ID = 'other.service'

function createServices(
  handlers: Record<string, (request: unknown) => unknown> = {}
): PluginHostServices {
  return {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
    listWorktreeTerminals: vi.fn().mockResolvedValue([]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: {
      get: vi.fn(),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn(),
      keys: vi.fn().mockReturnValue([])
    },
    secrets: {
      get: vi.fn().mockReturnValue({ ok: true, value: null }),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn()
    },
    settings: {
      getAll: vi.fn().mockReturnValue({}),
      set: vi.fn().mockReturnValue({ ok: true })
    },
    subscribeEvents: vi.fn().mockReturnValue([]),
    invokeService: vi.fn(async (_pluginId: string, serviceId: string, request: unknown) => {
      const handler = handlers[serviceId]
      if (!handler) {
        throw new Error(`unknown service: ${serviceId}`)
      }
      return handler(request)
    })
  }
}

function audit() {
  return { record: vi.fn().mockResolvedValue(undefined) }
}

describe('service.invoke scoped invocation', () => {
  it('allows an authorized service with a structured payload', async () => {
    const services = createServices({ [SERVICE_ID]: (request) => ({ echo: request }) })
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'service.invoke',
      params: { serviceId: SERVICE_ID, request: { op: 'ping' } },
      viaPanel: true,
      grantedCapabilities: ['service:invoke'],
      grantedServiceIds: [SERVICE_ID],
      services,
      audit: audit()
    })
    expect(outcome).toEqual({ ok: true, value: { response: { echo: { op: 'ping' } } } })
    expect(services.invokeService).toHaveBeenCalledWith(PLUGIN_KEY, SERVICE_ID, { op: 'ping' })
  })

  it('denies a service id outside the granted scope before execution', async () => {
    const invokeService = vi.fn()
    const services = createServices()
    services.invokeService = invokeService
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'service.invoke',
      params: { serviceId: OTHER_SERVICE_ID, request: { op: 'ping' } },
      viaPanel: true,
      grantedCapabilities: ['service:invoke'],
      grantedServiceIds: [SERVICE_ID],
      services,
      audit: audit()
    })
    expect(outcome).toMatchObject({ ok: false, code: 'capability_denied' })
    expect(invokeService).not.toHaveBeenCalled()
  })

  it('denies when the kind is missing even if a scope is supplied', async () => {
    const invokeService = vi.fn()
    const services = createServices()
    services.invokeService = invokeService
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'service.invoke',
      params: { serviceId: SERVICE_ID, request: null },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      grantedServiceIds: [SERVICE_ID],
      services,
      audit: audit()
    })
    expect(outcome).toMatchObject({ ok: false, code: 'capability_denied' })
    expect(invokeService).not.toHaveBeenCalled()
  })

  it('fails closed when the scope list is absent', async () => {
    const invokeService = vi.fn()
    const services = createServices()
    services.invokeService = invokeService
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'service.invoke',
      params: { serviceId: SERVICE_ID, request: null },
      viaPanel: false,
      grantedCapabilities: ['service:invoke'],
      services,
      audit: audit()
    })
    expect(outcome).toMatchObject({ ok: false, code: 'capability_denied' })
    expect(invokeService).not.toHaveBeenCalled()
  })

  it('requires current consent for service calls', async () => {
    const invokeService = vi.fn()
    const services = createServices()
    services.invokeService = invokeService
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'service.invoke',
      params: { serviceId: SERVICE_ID, request: null },
      viaPanel: true,
      grantedCapabilities: null,
      grantedServiceIds: null,
      services,
      audit: audit()
    })
    expect(outcome).toMatchObject({ ok: false, code: 'consent_required' })
    expect(invokeService).not.toHaveBeenCalled()
  })

  it('reports unknown services deterministically without leaking a grant', async () => {
    const services = createServices({})
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'service.invoke',
      params: { serviceId: SERVICE_ID, request: { op: 'ping' } },
      viaPanel: false,
      grantedCapabilities: ['service:invoke'],
      grantedServiceIds: [SERVICE_ID],
      services,
      audit: audit()
    })
    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain(`unknown service: ${SERVICE_ID}`)
  })

  it('rejects malformed service ids and extra exec-shaped fields', async () => {
    const invokeService = vi.fn()
    const services = createServices()
    services.invokeService = invokeService
    for (const params of [
      { serviceId: '../evil', request: null },
      { serviceId: '', request: null },
      { serviceId: 'a/b', request: null },
      { serviceId: SERVICE_ID, request: null, cmd: 'rm -rf /' },
      { serviceId: SERVICE_ID, request: null, shell: 'echo hi' },
      { serviceId: SERVICE_ID, request: null, cwd: '/tmp' },
      { serviceId: SERVICE_ID, request: null, env: { FOO: 'bar' } }
    ]) {
      const outcome = await executePluginHostCall({
        pluginId: PLUGIN_KEY,
        method: 'service.invoke',
        params,
        viaPanel: true,
        grantedCapabilities: ['service:invoke'],
        grantedServiceIds: [SERVICE_ID, '../evil'],
        services,
        audit: audit()
      })
      expect(outcome, JSON.stringify(params)).toMatchObject({ ok: false, code: 'invalid_params' })
    }
    expect(invokeService).not.toHaveBeenCalled()
  })

  it('rejects non-JSON requests before execution', async () => {
    const invokeService = vi.fn()
    const services = createServices()
    services.invokeService = invokeService
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'service.invoke',
      params: { serviceId: SERVICE_ID, request: new Date() },
      viaPanel: false,
      grantedCapabilities: ['service:invoke'],
      grantedServiceIds: [SERVICE_ID],
      services,
      audit: audit()
    })
    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(invokeService).not.toHaveBeenCalled()
  })

  it('rejects oversized requests before execution', async () => {
    const invokeService = vi.fn()
    const services = createServices()
    services.invokeService = invokeService
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'service.invoke',
      params: {
        serviceId: SERVICE_ID,
        request: { blob: 'x'.repeat(PLUGIN_SERVICE_REQUEST_MAX_BYTES) }
      },
      viaPanel: false,
      grantedCapabilities: ['service:invoke'],
      grantedServiceIds: [SERVICE_ID],
      services,
      audit: audit()
    })
    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(outcome.ok ? '' : outcome.error).toContain('exceeds')
    expect(invokeService).not.toHaveBeenCalled()
  })

  it('surfaces registered service failures as action_failed', async () => {
    const services = createServices({
      [SERVICE_ID]: () => {
        throw new Error('bridge exploded')
      }
    })
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'service.invoke',
      params: { serviceId: SERVICE_ID, request: { op: 'run' } },
      viaPanel: true,
      grantedCapabilities: ['service:invoke'],
      grantedServiceIds: [SERVICE_ID],
      services,
      audit: audit()
    })
    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('bridge exploded')
  })

  it('rejects oversized service responses without leaking payload bytes', async () => {
    const services = createServices({
      [SERVICE_ID]: () => ({ blob: 'y'.repeat(PLUGIN_SERVICE_RESPONSE_MAX_BYTES) })
    })
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'service.invoke',
      params: { serviceId: SERVICE_ID, request: null },
      viaPanel: false,
      grantedCapabilities: ['service:invoke'],
      grantedServiceIds: [SERVICE_ID],
      services,
      audit: audit()
    })
    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('exceeds')
  })

  it('reports unknown methods deterministically for old hosts', async () => {
    const decision = gatePluginHostCall(
      { grantedCapabilities: [], viaPanel: false },
      'service.erase'
    )
    expect(decision).toMatchObject({ granted: false, code: 'unknown_method' })
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'service.erase',
      params: { serviceId: SERVICE_ID },
      viaPanel: false,
      grantedCapabilities: ['service:invoke'],
      grantedServiceIds: [SERVICE_ID],
      services: createServices(),
      audit: audit()
    })
    expect(outcome).toMatchObject({ ok: false, code: 'unknown_method' })
  })

  it('keeps existing methods working with legacy kind-only grants', async () => {
    const services = createServices()
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'notifications.show',
      params: { title: 'Hello' },
      viaPanel: true,
      grantedCapabilities: ['notifications:show'],
      services,
      audit: audit()
    })
    expect(outcome).toMatchObject({ ok: true })
  })

  it('declares least-privilege service ids in the manifest and collects them', () => {
    const manifest = {
      manifestVersion: 1,
      id: 'demo',
      publisher: 'orca-samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      capabilities: [{ kind: 'service:invoke', serviceIds: [SERVICE_ID] }]
    }
    expect(parsePluginManifest(manifest).ok).toBe(true)
    const capabilities: PluginCapability[] = [{ kind: 'service:invoke', serviceIds: [SERVICE_ID] }]
    expect(collectGrantedServiceIds(capabilities)).toEqual([SERVICE_ID])
    expect(
      parsePluginManifest({ ...manifest, capabilities: [{ kind: 'service:invoke' }] }).ok
    ).toBe(false)
    expect(
      parsePluginManifest({
        ...manifest,
        capabilities: [{ kind: 'storage', serviceIds: [SERVICE_ID] }]
      }).ok
    ).toBe(false)
  })

  it('routes production binder calls through a host-owned registry', async () => {
    const services = bindPluginHostServices({
      delegate: {
        resolveActiveWorktreeContext: async () => null,
        listTerminals: async () => ({ terminals: [] }),
        sendTerminal: async () => ({ accepted: true }),
        dispatchPluginNotification: async () => ({ delivered: true })
      },
      pluginsDataDir: join(tmpdir(), 'service-invoke-binder-test'),
      subscribeEvents: () => [],
      services: new Map([['orca-pi.bridge', async (request) => ({ echo: request })]])
    })
    const outcome = await executePluginHostCall({
      pluginId: PLUGIN_KEY,
      method: 'service.invoke',
      params: { serviceId: 'orca-pi.bridge', request: { op: 'ping' } },
      viaPanel: true,
      grantedCapabilities: ['service:invoke'],
      grantedServiceIds: ['orca-pi.bridge'],
      services,
      audit: audit()
    })
    expect(outcome).toEqual({ ok: true, value: { response: { echo: { op: 'ping' } } } })
  })

  it('changes consent when only service ids change and projects them', async () => {
    const first = fingerprintPluginConsent({
      main: undefined,
      capabilities: [{ kind: 'service:invoke', serviceIds: ['orca-pi.bridge'] }]
    })
    const second = fingerprintPluginConsent({
      main: undefined,
      capabilities: [{ kind: 'service:invoke', serviceIds: ['other.service'] }]
    })
    expect(second).not.toBe(first)
    const manifest = pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'orca-samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: { panels: [], commands: [], events: [] },
      capabilities: [{ kind: 'service:invoke', serviceIds: ['orca-pi.bridge'] }]
    })
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: PLUGIN_KEY,
      rootDir: join(tmpdir(), 'plugins', 'demo'),
      manifest,
      consentFingerprint: 'sha256-current',
      contentHash: null,
      isDev: true
    }
    const service = {
      options: { getPluginConsents: () => ({}), getDisabledPlugins: () => [] },
      getDiscovered: () => [plugin],
      activationState: () => 'pending',
      workerState: () => ({ state: 'inactive', restarts: 0 }),
      activationError: () => null,
      contentPacks: {
        vmRecipes: { preview: () => [] },
        commands: { preview: () => [] }
      }
    } as unknown as PluginService
    const [entry] = await buildPluginList(service, emptyPluginLockfile())
    expect(entry?.capabilities).toMatchObject([
      { kind: 'service:invoke', serviceIds: ['orca-pi.bridge'] }
    ])
  })
})

const serviceInvokeRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    serviceInvokeRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('service.invoke production PluginService wiring', () => {
  it('invokes a host-registered service through PluginService.executeHostCall', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-service-invoke-service-'))
    serviceInvokeRoots.push(userDataPath)
    const pluginKey = PLUGIN_KEY
    const pluginDir = join(userDataPath, 'plugins', pluginKey)
    const stagingDir = join(pluginDir, 'staging')
    await mkdir(stagingDir, { recursive: true })
    const manifest = pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'orca-samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {
        panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }],
        commands: [],
        events: []
      },
      capabilities: [{ kind: 'service:invoke', serviceIds: [SERVICE_ID] }]
    })
    await writeFile(join(stagingDir, 'orca-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(stagingDir, 'panel.html'), '<h1>Panel</h1>')
    const content = await hashPluginTree(stagingDir)
    if (!content.ok) {
      throw new Error(content.error)
    }
    await rename(stagingDir, join(pluginDir, content.hash))
    await writeFile(join(pluginDir, 'current'), content.hash)
    const service = new PluginService({
      userDataPath,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => [],
      getPluginConsents: () => ({ [pluginKey]: fingerprintPluginConsent(manifest) }),
      getDevPluginPaths: () => [],
      hostServices: new Map([[SERVICE_ID, async (request) => ({ echo: request })]])
    })
    try {
      service.setRuntimeDelegate({
        resolveActiveWorktreeContext: async () => null,
        listTerminals: async () => ({ terminals: [] }),
        sendTerminal: async () => ({ accepted: true }),
        dispatchPluginNotification: async () => ({ delivered: true })
      })
      await service.initialize()
      const outcome = await service.executeHostCall(
        pluginKey,
        'service.invoke',
        { serviceId: SERVICE_ID, request: { op: 'ping' } },
        { viaPanel: true }
      )
      expect(outcome).toEqual({ ok: true, value: { response: { echo: { op: 'ping' } } } })
    } finally {
      await service.dispose()
    }
  })
})
