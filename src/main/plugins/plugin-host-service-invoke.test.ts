import { describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_SERVICE_REQUEST_MAX_BYTES,
  PLUGIN_SERVICE_RESPONSE_MAX_BYTES
} from '../../shared/plugins/plugin-host-api'
import {
  collectGrantedServiceIds,
  type PluginCapability
} from '../../shared/plugins/plugin-capabilities'
import { gatePluginHostCall } from '../../shared/plugins/plugin-capability-gate'
import { parsePluginManifest } from '../../shared/plugins/plugin-manifest'
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
})
