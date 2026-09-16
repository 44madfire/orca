import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema, type PluginManifest } from '../../shared/plugins/plugin-manifest'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginService } from './plugin-service'
import type { PluginWorkerFactory } from './plugin-worker-manager'

const roots: string[] = []
const services: PluginService[] = []

function manifestFor(
  publisher: string,
  id: string,
  options: { main?: string | null; capabilities?: PluginManifest['capabilities'] } = {}
): PluginManifest {
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id,
    publisher,
    name: id,
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    ...(options.main === null ? {} : { main: options.main ?? 'worker.js' }),
    contributes: {
      panels: [{ id: 'dashboard', title: 'Dashboard', entry: 'panel.html' }],
      commands: [],
      events: []
    },
    capabilities: options.capabilities ?? []
  })
}

async function pluginRoot(pluginManifest: PluginManifest): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-panel-rpc-service-'))
  roots.push(root)
  await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(pluginManifest))
  await writeFile(join(root, 'worker.js'), 'export default async function () {}')
  await writeFile(join(root, 'panel.html'), '<h1>Panel</h1>')
  return root
}

function testWorker(rpcMethods: string[] = ['panel.echo']): PluginWorkerHandle {
  return {
    commands: [],
    rpcMethods,
    invokeCommand: vi.fn(async () => null),
    invokeRpc: vi.fn(async (method: string) => ({ handled: method })),
    deliverEvent: vi.fn(),
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: vi.fn()
  }
}

function createService(
  entries: { key: string; manifest: PluginManifest; root: string; worker: PluginWorkerHandle }[]
): PluginService {
  const consents = Object.fromEntries(
    entries.map((entry) => [entry.key, fingerprintPluginConsent(entry.manifest)])
  )
  const factory = vi.fn<PluginWorkerFactory>(async (workerOptions) => {
    const entry = entries.find((candidate) => candidate.key === workerOptions.pluginId)
    if (!entry) {
      throw new Error('worker failed to start')
    }
    return entry.worker
  })
  const service = new PluginService({
    userDataPath: entries[0]!.root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => [],
    getPluginConsents: () => consents,
    getDevPluginPaths: () => entries.map((entry) => entry.root),
    workerFactory: factory
  })
  services.push(service)
  return service
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginService.invokePanelRpc', () => {
  it('dispatches to the bound worker with minimal host-derived context', async () => {
    const pluginManifest = manifestFor('orca-samples', 'alpha', {
      capabilities: [{ kind: 'storage' }]
    })
    const root = await pluginRoot(pluginManifest)
    const worker = testWorker()
    const service = createService([
      { key: 'orca-samples.alpha', manifest: pluginManifest, root, worker }
    ])
    await service.initialize()

    await expect(
      service.invokePanelRpc('orca-samples.alpha', 'dashboard', 'panel.echo', { n: 1 })
    ).resolves.toEqual({ ok: true, value: { handled: 'panel.echo' } })
    expect(worker.invokeRpc).toHaveBeenCalledWith(
      'panel.echo',
      { n: 1 },
      {
        panelId: 'dashboard',
        worktree: null,
        grantedCapabilities: ['storage']
      }
    )
  })

  it('routes two plugins to their own workers without cross-dispatch', async () => {
    const manifestA = manifestFor('orca-samples', 'alpha')
    const manifestB = manifestFor('orca-samples', 'beta')
    const rootA = await pluginRoot(manifestA)
    const rootB = await pluginRoot(manifestB)
    const workerA = testWorker()
    const workerB = testWorker()
    const service = createService([
      { key: 'orca-samples.alpha', manifest: manifestA, root: rootA, worker: workerA },
      { key: 'orca-samples.beta', manifest: manifestB, root: rootB, worker: workerB }
    ])
    await service.initialize()

    await service.invokePanelRpc('orca-samples.alpha', 'dashboard', 'panel.echo', null)
    expect(workerA.invokeRpc).toHaveBeenCalledTimes(1)
    expect(workerB.invokeRpc).not.toHaveBeenCalled()
  })

  it('returns unknown_method without invoking when the method is unregistered', async () => {
    const pluginManifest = manifestFor('orca-samples', 'alpha')
    const root = await pluginRoot(pluginManifest)
    const worker = testWorker(['panel.echo'])
    const service = createService([
      { key: 'orca-samples.alpha', manifest: pluginManifest, root, worker }
    ])
    await service.initialize()

    await expect(
      service.invokePanelRpc('orca-samples.alpha', 'dashboard', 'panel.missing', null)
    ).resolves.toMatchObject({ ok: false, code: 'unknown_method' })
    expect(worker.invokeRpc).not.toHaveBeenCalled()
  })

  it('maps handler failures to bounded action_failed', async () => {
    const pluginManifest = manifestFor('orca-samples', 'alpha')
    const root = await pluginRoot(pluginManifest)
    const worker = testWorker()
    worker.invokeRpc = vi.fn(async () => {
      throw new Error('x'.repeat(5000))
    })
    const service = createService([
      { key: 'orca-samples.alpha', manifest: pluginManifest, root, worker }
    ])
    await service.initialize()

    const outcome = await service.invokePanelRpc(
      'orca-samples.alpha',
      'dashboard',
      'panel.echo',
      null
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('action_failed')
      expect(outcome.error.length).toBeLessThanOrEqual(2048)
    }
  })

  it('maps worker lifecycle failures to unavailable', async () => {
    const pluginManifest = manifestFor('orca-samples', 'alpha')
    const root = await pluginRoot(pluginManifest)
    const worker = testWorker()
    worker.invokeRpc = vi.fn(async () => {
      throw new Error('[plugin:orca-samples.alpha] worker exited before responding')
    })
    const service = createService([
      { key: 'orca-samples.alpha', manifest: pluginManifest, root, worker }
    ])
    await service.initialize()

    await expect(
      service.invokePanelRpc('orca-samples.alpha', 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('fails closed for disabled plugins and plugins without a worker entry', async () => {
    const pluginManifest = manifestFor('orca-samples', 'alpha')
    const root = await pluginRoot(pluginManifest)
    const worker = testWorker()
    const consents = { 'orca-samples.alpha': fingerprintPluginConsent(pluginManifest) }
    const disabledService = new PluginService({
      userDataPath: root,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => ['orca-samples.alpha'],
      getPluginConsents: () => consents,
      getDevPluginPaths: () => [root],
      workerFactory: vi.fn<PluginWorkerFactory>(async () => worker)
    })
    services.push(disabledService)
    await disabledService.initialize()
    await expect(
      disabledService.invokePanelRpc('orca-samples.alpha', 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(worker.invokeRpc).not.toHaveBeenCalled()

    const noMainManifest = manifestFor('orca-samples', 'gamma', { main: null })
    const noMainRoot = await pluginRoot(noMainManifest)
    const noMainService = createService([
      {
        key: 'orca-samples.gamma',
        manifest: noMainManifest,
        root: noMainRoot,
        worker: testWorker()
      }
    ])
    await noMainService.initialize()
    await expect(
      noMainService.invokePanelRpc('orca-samples.gamma', 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
  })
})
