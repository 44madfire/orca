import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema, type PluginManifest } from '../../shared/plugins/plugin-manifest'
import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginPanelRpcContext } from '../../shared/plugins/plugin-host-protocol'
import { createPluginWorkerRuntime } from './plugin-host-runtime'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginService } from './plugin-service'
import type { PluginRuntimeDelegate } from './plugin-host-service-bindings'
import type { PluginWorkerFactory } from './plugin-worker-manager'
import {
  invokePanelRpcForPlugin,
  type PluginWorkerInvocationHost
} from './plugin-worker-invocation'
import { buildTrustedPanelRpcContext } from './plugin-panel-rpc-context'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

const roots: string[] = []
const services: PluginService[] = []

type WorktreeSnapshot = { worktreeId: string; path: string; branch: string; displayName: string }

const TRUSTED: WorktreeSnapshot = {
  worktreeId: 'repo::/trusted/path',
  path: '/trusted/path',
  branch: 'feature/rpc',
  displayName: 'trusted'
}

function manifestFor(
  publisher: string,
  id: string,
  capabilities: PluginManifest['capabilities'] = []
): PluginManifest {
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id,
    publisher,
    name: id,
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    main: 'worker.js',
    contributes: {
      panels: [{ id: 'dashboard', title: 'Dashboard', entry: 'panel.html' }],
      commands: [],
      events: []
    },
    capabilities
  })
}

async function pluginRoot(pluginManifest: PluginManifest): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-orpc3-'))
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
    invokeRpc: vi.fn(
      async (method: string, _params: unknown, _context: PluginPanelRpcContext) => ({
        handled: method
      })
    ),
    deliverEvent: vi.fn(),
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: vi.fn()
  }
}

function fakeDelegate(
  resolve: () => Promise<WorktreeSnapshot | null> = async () => ({ ...TRUSTED })
): PluginRuntimeDelegate & { resolveActiveWorktreeContext: ReturnType<typeof vi.fn> } {
  return {
    resolveActiveWorktreeContext: vi.fn(resolve),
    listTerminals: vi.fn(async () => ({ terminals: [] })),
    sendTerminal: vi.fn(async () => ({ accepted: true })),
    dispatchPluginNotification: vi.fn(async () => ({ delivered: true }))
  }
}

function createServiceWith(
  entries: { key: string; manifest: PluginManifest; root: string; worker: PluginWorkerHandle }[],
  options: { delegate?: PluginRuntimeDelegate | null; factoryGate?: () => Promise<void> } = {}
): PluginService {
  const consents = Object.fromEntries(
    entries.map((entry) => [entry.key, fingerprintPluginConsent(entry.manifest)])
  )
  const factory = vi.fn<PluginWorkerFactory>(async (workerOptions) => {
    if (options.factoryGate) {
      await options.factoryGate()
    }
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
  if (options.delegate !== undefined) {
    service.setRuntimeDelegate(options.delegate)
  }
  services.push(service)
  return service
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((inner) => {
    resolve = inner
  })
  return { promise, resolve }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ORPC-3 trusted per-request context', () => {
  it('attaches the trusted snapshot with workspace:read', async () => {
    const manifest = manifestFor('orca-samples', 'alpha', [{ kind: 'workspace:read' }])
    const root = await pluginRoot(manifest)
    const worker = testWorker()
    const delegate = fakeDelegate()
    const service = createServiceWith(
      [{ key: 'orca-samples.alpha', manifest, root, worker }],
      { delegate }
    )
    await service.initialize()

    await expect(
      service.invokePanelRpc('orca-samples.alpha', 'dashboard', 'panel.echo', { n: 1 })
    ).resolves.toMatchObject({ ok: true })
    expect(delegate.resolveActiveWorktreeContext).toHaveBeenCalledTimes(1)
    expect(worker.invokeRpc).toHaveBeenCalledWith(
      'panel.echo',
      { n: 1 },
      {
        panelId: 'dashboard',
        worktree: { ...TRUSTED },
        grantedCapabilities: ['workspace:read']
      }
    )
  })

  it('filters worktree to null without workspace:read and without calling the delegate', async () => {
    const manifest = manifestFor('orca-samples', 'alpha', [{ kind: 'storage' }])
    const root = await pluginRoot(manifest)
    const worker = testWorker()
    const delegate = fakeDelegate()
    const service = createServiceWith(
      [{ key: 'orca-samples.alpha', manifest, root, worker }],
      { delegate }
    )
    await service.initialize()

    await expect(
      service.invokePanelRpc('orca-samples.alpha', 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: true })
    expect(delegate.resolveActiveWorktreeContext).not.toHaveBeenCalled()
    expect(worker.invokeRpc).toHaveBeenCalledWith('panel.echo', null, {
      panelId: 'dashboard',
      worktree: null,
      grantedCapabilities: ['storage']
    })
  })

  it('executes with worktree null when the delegate is unavailable', async () => {
    const manifest = manifestFor('orca-samples', 'alpha', [{ kind: 'workspace:read' }])
    const root = await pluginRoot(manifest)
    const worker = testWorker()
    const service = createServiceWith(
      [{ key: 'orca-samples.alpha', manifest, root, worker }],
      { delegate: null }
    )
    await service.initialize()

    await expect(
      service.invokePanelRpc('orca-samples.alpha', 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: true })
    expect(worker.invokeRpc).toHaveBeenCalledWith('panel.echo', null, {
      panelId: 'dashboard',
      worktree: null,
      grantedCapabilities: ['workspace:read']
    })
  })

  it('returns unavailable when the delegate rejects', async () => {
    const manifest = manifestFor('orca-samples', 'alpha', [{ kind: 'workspace:read' }])
    const root = await pluginRoot(manifest)
    const worker = testWorker()
    const delegate = fakeDelegate(async () => {
      throw new Error('worktree store offline')
    })
    const service = createServiceWith(
      [{ key: 'orca-samples.alpha', manifest, root, worker }],
      { delegate }
    )
    await service.initialize()

    await expect(
      service.invokePanelRpc('orca-samples.alpha', 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(worker.invokeRpc).not.toHaveBeenCalled()
  })

  it('ignores panel params containing fake scope and binds panelId from the session', async () => {
    const manifest = manifestFor('orca-samples', 'alpha', [{ kind: 'workspace:read' }])
    const root = await pluginRoot(manifest)
    const worker = testWorker()
    const delegate = fakeDelegate()
    const service = createServiceWith(
      [{ key: 'orca-samples.alpha', manifest, root, worker }],
      { delegate }
    )
    await service.initialize()
    const entry = await service.panels.open('renderer:one', 'orca-samples.alpha', 'dashboard')
    expect(entry).not.toBeNull()

    const outcome = await service.panels.executeRpc('renderer:one', {
      sessionToken: entry!.sessionToken,
      method: 'panel.echo',
      params: {
        path: '/fake/path',
        projectRoot: '/fake/root',
        worktreeId: 'fake::/fake',
        panelId: 'fake-panel',
        worktree: { path: '/fake/nested', worktreeId: 'fake' }
      }
    })
    expect(outcome).toMatchObject({ ok: true })
    const context = vi.mocked(worker.invokeRpc).mock.calls[0]?.[2]
    expect(context?.panelId).toBe('dashboard')
    expect(context?.worktree).toEqual({ ...TRUSTED })
    expect(JSON.stringify(context)).not.toContain('/fake/')
  })

  it('keeps an admitted call on A across a focus switch to B (promise gates, no sleeps)', async () => {
    const worktreeA = { ...TRUSTED }
    const worktreeB = {
      worktreeId: 'repo::/other/path',
      path: '/other/path',
      branch: 'main',
      displayName: 'other'
    }
    let active = worktreeA
    const manifest = manifestFor('orca-samples', 'alpha', [{ kind: 'workspace:read' }])
    const root = await pluginRoot(manifest)
    const worker = testWorker()
    const delegate = fakeDelegate(async () => ({ ...active }))
    const entered = deferred()
    const gate = deferred()
    let factoryCalls = 0
    const consents = { 'orca-samples.alpha': fingerprintPluginConsent(manifest) }
    const factory = vi.fn<PluginWorkerFactory>(async () => {
      factoryCalls += 1
      if (factoryCalls === 1) {
        entered.resolve()
        await gate.promise
      }
      return worker
    })
    const service = new PluginService({
      userDataPath: root,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => [],
      getPluginConsents: () => consents,
      getDevPluginPaths: () => [root],
      workerFactory: factory
    })
    service.setRuntimeDelegate(delegate)
    services.push(service)
    await service.initialize()

    const first = service.invokePanelRpc('orca-samples.alpha', 'dashboard', 'panel.echo', null)
    await entered.promise
    expect(delegate.resolveActiveWorktreeContext).toHaveBeenCalledTimes(1)
    active = worktreeB
    gate.resolve()
    await expect(first).resolves.toMatchObject({ ok: true })
    const firstContext = vi.mocked(worker.invokeRpc).mock.calls[0]?.[2]
    expect(firstContext?.worktree).toEqual(worktreeA)

    await expect(
      service.invokePanelRpc('orca-samples.alpha', 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: true })
    const secondContext = vi.mocked(worker.invokeRpc).mock.calls[1]?.[2]
    expect(secondContext?.worktree).toEqual(worktreeB)
  })
})

describe('ORPC-3 consent race uses fresh per-request grants', () => {
  function fakeHost(
    plugin: ValidDiscoveredPlugin,
    state: { grants: PluginCapabilityKind[] | null; approved: boolean },
    worker: PluginWorkerHandle,
    snapshot: WorktreeSnapshot | null = { ...TRUSTED }
  ): PluginWorkerInvocationHost & { ensure: ReturnType<typeof vi.fn> } {
    const ensure = vi.fn(async () => worker)
    return {
      findValidPlugin: () => plugin,
      isRuntimeApproved: () => state.approved,
      getGrantedCapabilities: () => (state.grants ? [...state.grants] : null),
      resolveActiveWorktreeContext: async () => (snapshot ? { ...snapshot } : null),
      workerController: { ensure },
      ensure
    }
  }

  async function fakePlugin(): Promise<ValidDiscoveredPlugin> {
    const manifest = manifestFor('orca-samples', 'alpha', [{ kind: 'workspace:read' }])
    const rootDir = await pluginRoot(manifest)
    return {
      pluginKey: 'orca-samples.alpha',
      rootDir,
      manifest,
      consentFingerprint: 'sha256-consented',
      contentHash: null,
      isDev: true
    }
  }

  it('revoke and re-grant change the next call without a worker restart', async () => {
    const plugin = await fakePlugin()
    const worker = testWorker()
    const state: { grants: PluginCapabilityKind[] | null; approved: boolean } = {
      grants: ['workspace:read'],
      approved: true
    }
    const host = fakeHost(plugin, state, worker)
    // Why: activation-time orca.grantedCapabilities is informational only;
    // capture the real init array so the test proves per-request wins over
    // what the worker actually saw at startup, not over a local const.
    let activationGrants: readonly string[] | null = null
    const runtime = createPluginWorkerRuntime({
      send: vi.fn(),
      importModule: async () => ({
        default: (orca: { grantedCapabilities: readonly string[] }) => {
          activationGrants = [...orca.grantedCapabilities]
        }
      })
    })
    await runtime.handleMessage({
      type: 'init',
      pluginId: plugin.pluginKey,
      pluginRoot: plugin.rootDir,
      mainEntry: 'worker.js',
      grantedCapabilities: ['workspace:read']
    })
    expect(activationGrants).toEqual(['workspace:read'])

    await expect(
      invokePanelRpcForPlugin(host, plugin.pluginKey, 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: true })
    expect(worker.invokeRpc).toHaveBeenLastCalledWith(
      'panel.echo',
      null,
      expect.objectContaining({ worktree: { ...TRUSTED } })
    )

    state.grants = []
    await expect(
      invokePanelRpcForPlugin(host, plugin.pluginKey, 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: true })
    // Activation still claims workspace:read; the revoked per-request wins.
    expect(activationGrants).toContain('workspace:read')
    expect(worker.invokeRpc).toHaveBeenLastCalledWith(
      'panel.echo',
      null,
      expect.objectContaining({ worktree: null, grantedCapabilities: [] })
    )

    state.grants = ['workspace:read']
    await expect(
      invokePanelRpcForPlugin(host, plugin.pluginKey, 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: true })
    expect(worker.invokeRpc).toHaveBeenLastCalledWith(
      'panel.echo',
      null,
      expect.objectContaining({ worktree: { ...TRUSTED } })
    )
    expect(host.ensure).toHaveBeenCalledTimes(3)
  })

  it('refuses dispatch for disabled or unapproved plugins without touching the worker', async () => {
    const plugin = await fakePlugin()
    const worker = testWorker()
    const state: { grants: PluginCapabilityKind[] | null; approved: boolean } = {
      grants: ['workspace:read'],
      approved: false
    }
    const host = fakeHost(plugin, state, worker)

    await expect(
      invokePanelRpcForPlugin(host, plugin.pluginKey, 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(worker.invokeRpc).not.toHaveBeenCalled()
    expect(host.ensure).not.toHaveBeenCalled()
  })
})

describe('ORPC-3 session and worker replacement', () => {
  it('rejects a revoked session before snapshotting or dispatch', async () => {
    const manifest = manifestFor('orca-samples', 'alpha', [{ kind: 'workspace:read' }])
    const root = await pluginRoot(manifest)
    const worker = testWorker()
    const delegate = fakeDelegate()
    const service = createServiceWith(
      [{ key: 'orca-samples.alpha', manifest, root, worker }],
      { delegate }
    )
    await service.initialize()
    const entry = await service.panels.open('renderer:one', 'orca-samples.alpha', 'dashboard')

    service.panels.revokeOwner('renderer:one')
    await expect(
      service.panels.executeRpc('renderer:one', {
        sessionToken: entry!.sessionToken,
        method: 'panel.echo'
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })
    expect(delegate.resolveActiveWorktreeContext).not.toHaveBeenCalled()
    expect(worker.invokeRpc).not.toHaveBeenCalled()
  })

  it('builds an independent context per call across a worker restart', async () => {
    const manifest = manifestFor('orca-samples', 'alpha', [{ kind: 'workspace:read' }])
    const rootDir = await pluginRoot(manifest)
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.alpha',
      rootDir,
      manifest,
      consentFingerprint: 'sha256-consented',
      contentHash: null,
      isDev: true
    }
    const workerOne = testWorker()
    const workerTwo = testWorker()
    const snapshots = [
      { ...TRUSTED },
      { worktreeId: 'repo::/next', path: '/next', branch: 'next', displayName: 'next' }
    ]
    let callIndex = 0
    const host: PluginWorkerInvocationHost = {
      findValidPlugin: () => plugin,
      isRuntimeApproved: () => true,
      getGrantedCapabilities: () => ['workspace:read'],
      resolveActiveWorktreeContext: async () => ({ ...snapshots[callIndex]! }),
      workerController: {
        ensure: vi.fn(async () => (callIndex === 0 ? workerOne : workerTwo))
      }
    }

    await expect(
      invokePanelRpcForPlugin(host, plugin.pluginKey, 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: true })
    callIndex = 1
    await expect(
      invokePanelRpcForPlugin(host, plugin.pluginKey, 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: true })

    expect(workerOne.invokeRpc).toHaveBeenCalledTimes(1)
    expect(workerTwo.invokeRpc).toHaveBeenCalledTimes(1)
    expect(workerOne.invokeRpc).toHaveBeenCalledWith(
      'panel.echo',
      null,
      expect.objectContaining({ worktree: snapshots[0] })
    )
    expect(workerTwo.invokeRpc).toHaveBeenCalledWith(
      'panel.echo',
      null,
      expect.objectContaining({ worktree: snapshots[1] })
    )
  })
})

describe('ORPC-3 path fidelity', () => {
  const paths = [
    '/home/user/project',
    'C:\\Users\\user\\project',
    '\\\\server\\share\\project',
    '\\\\wsl.localhost\\Ubuntu\\home\\user\\project'
  ]

  it.each(paths)('transports %s losslessly from delegate to worker', async (path) => {
    const manifest = manifestFor('orca-samples', 'alpha', [{ kind: 'workspace:read' }])
    const root = await pluginRoot(manifest)
    const worker = testWorker()
    const delegate = fakeDelegate(async () => ({
      worktreeId: `repo::${path}`,
      path,
      branch: 'feature/rpc',
      displayName: 'trusted'
    }))
    const service = createServiceWith(
      [{ key: 'orca-samples.alpha', manifest, root, worker }],
      { delegate }
    )
    await service.initialize()

    await expect(
      service.invokePanelRpc('orca-samples.alpha', 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: true })
    const context = vi.mocked(worker.invokeRpc).mock.calls[0]?.[2]
    expect(context?.worktree?.path).toBe(path)
    expect(context?.worktree?.worktreeId).toBe(`repo::${path}`)
  })

  it.each(paths)('round-trips %s through the fork protocol to the handler', async (path) => {
    const seen: unknown[] = []
    const runtime = createPluginWorkerRuntime({
      send: vi.fn(),
      importModule: async () => ({
        default: (orca: {
          rpc: { register: (method: string, handler: (params: unknown, ctx: unknown) => unknown) => void }
        }) => {
          orca.rpc.register('panel.echo', (_params: unknown, context: unknown) => {
            seen.push(context)
            return { ok: true }
          })
        }
      })
    })
    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'worker.js',
      grantedCapabilities: []
    })
    const context = buildTrustedPanelRpcContext('dashboard', ['workspace:read'], {
      worktreeId: `repo::${path}`,
      path,
      branch: 'feature/rpc',
      displayName: 'trusted'
    })
    await runtime.handleMessage({ type: 'invokeRpc', callId: 1, method: 'panel.echo', context })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ worktree: { path } })
  })
})

describe('ORPC-3 malformed snapshots and grant flips fail closed', () => {
  function malformedHost(
    plugin: ValidDiscoveredPlugin,
    snapshot: unknown,
    worker: PluginWorkerHandle
  ): PluginWorkerInvocationHost & { ensure: ReturnType<typeof vi.fn> } {
    const ensure = vi.fn(async () => worker)
    return {
      findValidPlugin: () => plugin,
      isRuntimeApproved: () => true,
      getGrantedCapabilities: () => ['workspace:read'],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixtures prove malformed delegate output fails closed.
      resolveActiveWorktreeContext: async () => snapshot as never,
      workerController: { ensure },
      ensure
    }
  }

  async function malformedPlugin(): Promise<ValidDiscoveredPlugin> {
    const manifest = manifestFor('orca-samples', 'alpha', [{ kind: 'workspace:read' }])
    const rootDir = await pluginRoot(manifest)
    return {
      pluginKey: 'orca-samples.alpha',
      rootDir,
      manifest,
      consentFingerprint: 'sha256-consented',
      contentHash: null,
      isDev: true
    }
  }

  it.each([
    ['empty worktreeId', { worktreeId: '', path: '/repo', branch: 'main', displayName: 'repo' }],
    ['empty path', { worktreeId: 'repo::/repo', path: '', branch: 'main', displayName: 'repo' }],
    [
      'non-string branch',
      { worktreeId: 'repo::/repo', path: '/repo', branch: 42, displayName: 'repo' }
    ],
    [
      'non-string displayName',
      { worktreeId: 'repo::/repo', path: '/repo', branch: 'main', displayName: null }
    ],
    [
      'oversized path',
      { worktreeId: 'repo::/repo', path: `/${'x'.repeat(4096)}`, branch: 'main', displayName: 'repo' }
    ],
    [
      'oversized worktreeId',
      { worktreeId: `w${'y'.repeat(1024)}`, path: '/repo', branch: 'main', displayName: 'repo' }
    ],
    [
      'oversized branch',
      { worktreeId: 'repo::/repo', path: '/repo', branch: 'b'.repeat(513), displayName: 'repo' }
    ],
    [
      'oversized displayName',
      { worktreeId: 'repo::/repo', path: '/repo', branch: 'main', displayName: 'd'.repeat(513) }
    ]
  ])('rejects malformed snapshot (%s) as bounded unavailable before worker ensure', async (_label, snapshot) => {
    const plugin = await malformedPlugin()
    const worker = testWorker()
    const host = malformedHost(plugin, snapshot, worker)

    const outcome = await invokePanelRpcForPlugin(host, plugin.pluginKey, 'dashboard', 'panel.echo', null)
    expect(outcome).toMatchObject({ ok: false, code: 'unavailable' })
    expect(host.ensure).not.toHaveBeenCalled()
    expect(worker.invokeRpc).not.toHaveBeenCalled()
  })

  it('fails closed when grants flip to null between checks', async () => {
    const plugin = await malformedPlugin()
    const worker = testWorker()
    const ensure = vi.fn(async () => worker)
    const resolveActiveWorktreeContext = vi.fn(async () => ({ ...TRUSTED }))
    const host: PluginWorkerInvocationHost = {
      findValidPlugin: () => plugin,
      isRuntimeApproved: () => true,
      getGrantedCapabilities: () => null,
      resolveActiveWorktreeContext,
      workerController: { ensure }
    }

    await expect(
      invokePanelRpcForPlugin(host, plugin.pluginKey, 'dashboard', 'panel.echo', null)
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(resolveActiveWorktreeContext).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
    expect(worker.invokeRpc).not.toHaveBeenCalled()
  })

  it('keeps concurrent calls on their own snapshots (promise gates, no sleeps)', async () => {
    const plugin = await malformedPlugin()
    const worker = testWorker()
    const worktreeA = { ...TRUSTED }
    const worktreeB = {
      worktreeId: 'repo::/other/path',
      path: '/other/path',
      branch: 'main',
      displayName: 'other'
    }
    let active = worktreeA
    const enteredFirst = deferred()
    const releaseFirst = deferred()
    const enteredSecond = deferred()
    const releaseSecond = deferred()
    let ensureCalls = 0
    const ensure = vi.fn(async () => {
      ensureCalls += 1
      if (ensureCalls === 1) {
        enteredFirst.resolve()
        await releaseFirst.promise
      } else {
        enteredSecond.resolve()
        await releaseSecond.promise
      }
      return worker
    })
    const host: PluginWorkerInvocationHost = {
      findValidPlugin: () => plugin,
      isRuntimeApproved: () => true,
      getGrantedCapabilities: () => ['workspace:read'],
      resolveActiveWorktreeContext: async () => ({ ...active }),
      workerController: { ensure }
    }

    const first = invokePanelRpcForPlugin(host, plugin.pluginKey, 'dashboard', 'panel.echo', { n: 1 })
    await enteredFirst.promise
    active = worktreeB
    const second = invokePanelRpcForPlugin(host, plugin.pluginKey, 'dashboard', 'panel.echo', { n: 2 })
    await enteredSecond.promise
    releaseFirst.resolve()
    releaseSecond.resolve()
    await expect(first).resolves.toMatchObject({ ok: true })
    await expect(second).resolves.toMatchObject({ ok: true })
    expect(ensure).toHaveBeenCalledTimes(2)
    const contexts = vi.mocked(worker.invokeRpc).mock.calls.map((call) => call[2])
    expect(contexts).toHaveLength(2)
    expect(contexts[0]?.worktree).toEqual(worktreeA)
    expect(contexts[1]?.worktree).toEqual(worktreeB)
    // Params stay paired with their own snapshot; no cross-wiring.
    expect(vi.mocked(worker.invokeRpc).mock.calls[0]?.[1]).toEqual({ n: 1 })
    expect(vi.mocked(worker.invokeRpc).mock.calls[1]?.[1]).toEqual({ n: 2 })
  })
})

describe('ORPC-3 desktop and runtime parity', () => {
  it('enforces the same grants and session binding for both owners', async () => {
    const manifest = manifestFor('orca-samples', 'alpha', [{ kind: 'workspace:read' }])
    const root = await pluginRoot(manifest)
    const worker = testWorker()
    const delegate = fakeDelegate()
    const service = createServiceWith(
      [{ key: 'orca-samples.alpha', manifest, root, worker }],
      { delegate }
    )
    await service.initialize()

    const desktop = await service.panels.open('renderer:one', 'orca-samples.alpha', 'dashboard')
    const runtimeEntry = await service.panels.open(
      'runtime:connection-one',
      'orca-samples.alpha',
      'dashboard'
    )
    await expect(
      service.panels.executeRpc('renderer:one', {
        sessionToken: desktop!.sessionToken,
        method: 'panel.echo'
      })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      service.panels.executeRpc('runtime:connection-one', {
        sessionToken: runtimeEntry!.sessionToken,
        method: 'panel.echo'
      })
    ).resolves.toMatchObject({ ok: true })
    const contexts = vi.mocked(worker.invokeRpc).mock.calls.map((call) => call[2])
    expect(contexts).toHaveLength(2)
    expect(contexts[0]).toEqual(contexts[1])
    expect(contexts[0]?.worktree).toEqual({ ...TRUSTED })

    // A session bound to one owner cannot be replayed by the other owner.
    await expect(
      service.panels.executeRpc('runtime:connection-one', {
        sessionToken: desktop!.sessionToken,
        method: 'panel.echo'
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })
    expect(worker.invokeRpc).toHaveBeenCalledTimes(2)
  })
})
