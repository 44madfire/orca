import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../src/shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema, type PluginManifest } from '../../src/shared/plugins/plugin-manifest'
import type { PluginPanelRpcContext } from '../../src/shared/plugins/plugin-host-protocol'
import type { PluginPanelRpcOutcome } from '../../src/shared/plugins/plugin-panel-bridge'
import { createPluginWorkerRuntime } from '../../src/main/plugins/plugin-host-runtime'
import type { PluginWorkerHandle } from '../../src/main/plugins/plugin-host-process'
import type { PluginWorkerFactory } from '../../src/main/plugins/plugin-worker-manager'
import type { PluginRuntimeDelegate } from '../../src/main/plugins/plugin-host-service-bindings'
import { PluginWorkerRpcError } from '../../src/main/plugins/plugin-worker-rpc-failure'
import { PluginService } from '../../src/main/plugins/plugin-service'
import { createPanelBridgeMessageHandler } from '../../src/renderer/src/components/right-sidebar/plugin-panel-bridge-host'

const roots: string[] = []
const services: PluginService[] = []

const TRUSTED = {
  worktreeId: 'repo::/trusted/path',
  path: '/trusted/path',
  branch: 'feature/rpc',
  displayName: 'trusted'
}

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
  const root = await mkdtemp(join(tmpdir(), 'orca-orpc4-e2e-'))
  roots.push(root)
  await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'worker.js'), 'export default async function () {}')
  await writeFile(join(root, 'panel.html'), '<h1>Panel</h1>')
  return root
}

function fakeDelegate(
  snapshot: typeof TRUSTED | null = { ...TRUSTED }
): PluginRuntimeDelegate & { resolveActiveWorktreeContext: ReturnType<typeof vi.fn> } {
  return {
    resolveActiveWorktreeContext: vi.fn(async () => (snapshot ? { ...snapshot } : null)),
    listTerminals: vi.fn(async () => ({ terminals: [] })),
    sendTerminal: vi.fn(async () => ({ accepted: true })),
    dispatchPluginNotification: vi.fn(async () => ({ delivered: true }))
  }
}

// Why: fake fork transport — the handle speaks the real parent↔child RPC
// schema to a live plugin-host runtime (same hello.getStatus shape as the
// hello-orca sample) without forking a real child process.
function runtimeBackedFactory(options: {
  seenContexts: PluginPanelRpcContext[]
  activationGrants: { grants: readonly string[] | null }
  handler?: (params: unknown, context: PluginPanelRpcContext) => unknown
  // Rejects invokeRpc with the typed worker_exit failure, mirroring
  // PluginWorkerRpcCalls.rejectAfterExit when the child is gone.
  workerExitMessage?: string
}): PluginWorkerFactory {
  return async (workerOptions) => {
    options.activationGrants.grants = [...workerOptions.grantedCapabilities]
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
            // Mirrors PluginWorkerRpcCalls.handleResult: the wire carries
            // only an error string, so every ok:false is an action_failed.
            entry.reject(new PluginWorkerRpcError('action_failed', message.error))
          }
        }
      },
      importModule: async () => ({
        default: (orca: {
          rpc: { register: (method: string, handler: (params: unknown, context: PluginPanelRpcContext) => unknown) => void }
        }) => {
          orca.rpc.register('hello.getStatus', async (params, context) => {
            options.seenContexts.push(structuredClone(context))
            if (options.handler) {
              return options.handler(params, context)
            }
            return {
              echo: params ?? null,
              panelId: context.panelId,
              worktree: context.worktree
                ? { branch: context.worktree.branch, displayName: context.worktree.displayName }
                : null
            }
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
        // Worker-gone short-circuit: no runtime dispatch, exactly like a
        // parent-side pre-check rejection after the child exits.
        if (options.workerExitMessage !== undefined) {
          return Promise.reject(
            new PluginWorkerRpcError('worker_exit', options.workerExitMessage)
          )
        }
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

async function createE2EService(options: {
  delegate?: PluginRuntimeDelegate | null
  seenContexts?: PluginPanelRpcContext[]
  activationGrants?: { grants: readonly string[] | null }
  handler?: (params: unknown, context: PluginPanelRpcContext) => unknown
  workerExitMessage?: string
} = {}): Promise<{
  service: PluginService
  ownerKey: string
  sessionToken: string
  seenContexts: PluginPanelRpcContext[]
  activationGrants: { grants: readonly string[] | null }
  delegate: PluginRuntimeDelegate | null
}> {
  const manifest = manifestFor()
  const root = await pluginRoot(manifest)
  const seenContexts = options.seenContexts ?? []
  const activationGrants = options.activationGrants ?? { grants: null }
  const delegate = options.delegate === undefined ? fakeDelegate() : options.delegate
  const factory = runtimeBackedFactory({
    seenContexts,
    activationGrants,
    handler: options.handler,
    workerExitMessage: options.workerExitMessage
  })
  const consents = { 'orca-samples.alpha': fingerprintPluginConsent(manifest) }
  const service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => [],
    getPluginConsents: () => consents,
    getDevPluginPaths: () => [root],
    workerFactory: vi.fn(factory)
  })
  if (delegate) {
    service.setRuntimeDelegate(delegate)
  }
  services.push(service)
  await service.initialize()
  const ownerKey = 'renderer:7'
  const entry = await service.panels.open(ownerKey, 'orca-samples.alpha', 'dashboard')
  if (!entry) {
    throw new Error('panel failed to open')
  }
  return { service, ownerKey, sessionToken: entry.sessionToken, seenContexts, activationGrants, delegate }
}

type FakePanelWindow = { postMessage: ReturnType<typeof vi.fn> }

type PanelResult = {
  type: string
  requestId: string
  ok: boolean
  value?: unknown
  errorCode?: string
  error?: string
}

function isPanelResultMessage(value: unknown): value is PanelResult {
  if (typeof value !== 'object' || value === null || !('requestId' in value)) {
    return false
  }
  return typeof value.requestId === 'string'
}

// Why: single postMessage mock demultiplexes by requestId so concurrent
// panel RPCs correlate deterministically via promise gates, never sleeps.
function createE2EPanelHarness(options: {
  service: PluginService
  ownerKey: string
  sessionToken: string
  callPanelRpc?: (call: {
    sessionToken: string
    method: string
    params?: unknown
  }) => Promise<PluginPanelRpcOutcome>
  isActive?: () => boolean
}): {
  panelWindow: FakePanelWindow
  handler: (event: { data: unknown; source: unknown }) => void
  waitFor: (requestId: string) => Promise<PanelResult>
} {
  const panelWindow: FakePanelWindow = { postMessage: vi.fn() }
  const results = new Map<string, PanelResult>()
  const waiters = new Map<string, (value: PanelResult) => void>()
  vi.mocked(panelWindow.postMessage).mockImplementation((message: unknown) => {
    if (isPanelResultMessage(message)) {
      results.set(message.requestId, message)
      waiters.get(message.requestId)?.(message)
    }
    return undefined
  })
  // Why: mirrors PluginPanel wiring — the renderer attaches the host-issued
  // session at relay time; preload/main re-resolve it, never trusting the frame.
  const bridgeHandler = createPanelBridgeMessageHandler({
    sessionToken: options.sessionToken,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge handler reads only postMessage from the panel window and compares it by identity; the double supplies exactly that member and every test asserts the reply lands on the same object.
    getPanelWindow: () => panelWindow as unknown as Window,
    callPanelAction: vi.fn(async () => ({ ok: true, value: null }) as const),
    callPanelRpc:
      options.callPanelRpc ??
      ((call) => options.service.panels.executeRpc(options.ownerKey, call)),
    ...(options.isActive === undefined ? {} : { isActive: options.isActive })
  })
  const emitRpc = (data: unknown, source: unknown): void => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge handler reads only event.data and event.source; the double carries exactly those two members and every test asserts dispatch/reply behavior on the result.
    bridgeHandler({ data, source } as MessageEvent)
  }
  return {
    panelWindow,
    handler: (event: { data: unknown; source: unknown }): void => {
      emitRpc(event.data, event.source)
    },
    waitFor: (requestId: string) => {
      const existing = results.get(requestId)
      if (existing) {
        return Promise.resolve(existing)
      }
      return new Promise<PanelResult>((resolve) => {
        waiters.set(requestId, resolve)
      })
    }
  }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

describe('ORPC-4 real-stack panel→worker E2E', () => {
  it('traverses panel message → bridge → session → service → runtime → panel result', async () => {
    const { service, ownerKey, sessionToken, seenContexts, activationGrants } =
      await createE2EService()
    const harness = createE2EPanelHarness({ service, ownerKey, sessionToken })
    const resultPromise = harness.waitFor('rpc-1')

    harness.handler({
      data: { type: 'orca-panel-rpc', requestId: 'rpc-1', method: 'hello.getStatus', params: { hello: 'panel' } },
      source: harness.panelWindow
    })

    const result = await resultPromise
    expect(result).toMatchObject({
      type: 'orca-panel-rpc-result',
      requestId: 'rpc-1',
      ok: true,
      value: {
        echo: { hello: 'panel' },
        panelId: 'dashboard',
        worktree: { branch: 'feature/rpc', displayName: 'trusted' }
      }
    })
    // The worker saw the full trusted snapshot; the panel saw only the
    // branch/displayName projection — the path never reaches panel output.
    expect(seenContexts).toHaveLength(1)
    expect(seenContexts[0]?.worktree).toEqual({ ...TRUSTED })
    expect(JSON.stringify(result)).not.toContain('/trusted/path')
    expect(activationGrants.grants).toEqual(['workspace:read'])
  })

  it('ignores fake authority nested in params and still binds the trusted session', async () => {
    const { service, ownerKey, sessionToken, seenContexts } = await createE2EService()
    const harness = createE2EPanelHarness({ service, ownerKey, sessionToken })
    const resultPromise = harness.waitFor('rpc-2')

    harness.handler({
      data: {
        type: 'orca-panel-rpc',
        requestId: 'rpc-2',
        method: 'hello.getStatus',
        params: {
          hello: 'panel',
          pluginKey: 'orca-samples.other',
          panelId: 'fake-panel',
          worktree: { path: '/fake/nested', worktreeId: 'fake' },
          path: '/fake/path'
        }
      },
      source: harness.panelWindow
    })

    const result = await resultPromise
    expect(result).toMatchObject({ requestId: 'rpc-2', ok: true })
    expect(seenContexts).toHaveLength(1)
    expect(seenContexts[0]?.panelId).toBe('dashboard')
    expect(seenContexts[0]?.worktree).toEqual({ ...TRUSTED })
    // Fake scope must not retarget the trusted worktree or the projected
    // panel worktree; it survives only inside the echoed params payload.
    expect(seenContexts[0]?.worktree?.path).toBe(TRUSTED.path)
    expect(result.value).toMatchObject({
      worktree: { branch: TRUSTED.branch, displayName: TRUSTED.displayName }
    })
  })

  it('correlates two concurrent panel RPCs to matching results out of order', async () => {
    const { service, ownerKey, sessionToken } = await createE2EService()
    const harness = createE2EPanelHarness({ service, ownerKey, sessionToken })
    const firstPromise = harness.waitFor('rpc-a')
    const secondPromise = harness.waitFor('rpc-b')
    harness.handler({
      data: { type: 'orca-panel-rpc', requestId: 'rpc-a', method: 'hello.getStatus', params: { n: 1 } },
      source: harness.panelWindow
    })
    harness.handler({
      data: { type: 'orca-panel-rpc', requestId: 'rpc-b', method: 'hello.getStatus', params: { n: 2 } },
      source: harness.panelWindow
    })
    const [first, second] = await Promise.all([firstPromise, secondPromise])
    expect(first).toMatchObject({ requestId: 'rpc-a', ok: true, value: { echo: { n: 1 } } })
    expect(second).toMatchObject({ requestId: 'rpc-b', ok: true, value: { echo: { n: 2 } } })
  })

  it('delivers a bounded action_failed result when the worker handler throws', async () => {
    const { service, ownerKey, sessionToken } = await createE2EService({
      handler: () => {
        throw new Error(`boom-${'x'.repeat(9000)}`)
      }
    })
    const harness = createE2EPanelHarness({ service, ownerKey, sessionToken })
    const resultPromise = harness.waitFor('rpc-err')

    harness.handler({
      data: { type: 'orca-panel-rpc', requestId: 'rpc-err', method: 'hello.getStatus' },
      source: harness.panelWindow
    })

    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('action_failed')
    expect(typeof result.error).toBe('string')
    if (typeof result.error !== 'string') {
      throw new Error('expected a bounded string error from the failed RPC')
    }
    expect(result.error.length).toBeLessThanOrEqual(8192)
  })

  it('rejects a revoked session before worker dispatch', async () => {
    const { service, ownerKey, sessionToken, seenContexts } = await createE2EService()
    const harness = createE2EPanelHarness({ service, ownerKey, sessionToken })
    service.panels.revokeOwner(ownerKey)
    const resultPromise = harness.waitFor('rpc-revoked')

    harness.handler({
      data: { type: 'orca-panel-rpc', requestId: 'rpc-revoked', method: 'hello.getStatus' },
      source: harness.panelWindow
    })

    await expect(resultPromise).resolves.toMatchObject({
      requestId: 'rpc-revoked',
      ok: false,
      errorCode: 'invalid_request'
    })
    expect(seenContexts).toHaveLength(0)
  })

  it('rejects an unknown method without running the worker handler', async () => {
    const { service, ownerKey, sessionToken, seenContexts } = await createE2EService()
    const harness = createE2EPanelHarness({ service, ownerKey, sessionToken })
    const resultPromise = harness.waitFor('rpc-unknown')

    harness.handler({
      data: { type: 'orca-panel-rpc', requestId: 'rpc-unknown', method: 'hello.missing' },
      source: harness.panelWindow
    })

    await expect(resultPromise).resolves.toMatchObject({
      requestId: 'rpc-unknown',
      ok: false,
      errorCode: 'unknown_method'
    })
    expect(seenContexts).toHaveLength(0)
  })

  it('keeps the runtime/serve owner on the same authority as the desktop owner', async () => {
    const { service, seenContexts } = await createE2EService()
    const desktop = await service.panels.open('renderer:one', 'orca-samples.alpha', 'dashboard')
    const runtimeEntry = await service.panels.open(
      'runtime:connection-one',
      'orca-samples.alpha',
      'dashboard'
    )
    const desktopOutcome = await service.panels.executeRpc('renderer:one', {
      sessionToken: desktop!.sessionToken,
      method: 'hello.getStatus',
      params: { hello: 'panel' }
    })
    const runtimeOutcome = await service.panels.executeRpc('runtime:connection-one', {
      sessionToken: runtimeEntry!.sessionToken,
      method: 'hello.getStatus',
      params: { hello: 'panel' }
    })
    expect(desktopOutcome).toEqual(runtimeOutcome)
    expect(desktopOutcome).toMatchObject({ ok: true })
    // Cross-owner replay stays rejected.
    await expect(
      service.panels.executeRpc('runtime:connection-one', {
        sessionToken: desktop!.sessionToken,
        method: 'hello.getStatus'
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })
    expect(seenContexts.length).toBeGreaterThanOrEqual(2)
  })
})

describe('ORPC-4 security regression through the real stack', () => {
  it('ignores an RPC-shaped message from any other window', async () => {
    const { service, ownerKey, sessionToken, seenContexts } = await createE2EService()
    const harness = createE2EPanelHarness({ service, ownerKey, sessionToken })
    const otherWindow: FakePanelWindow = { postMessage: vi.fn() }
    harness.handler({
      data: { type: 'orca-panel-rpc', requestId: 'rpc-evil', method: 'hello.getStatus' },
      source: otherWindow
    })
    harness.handler({
      data: { type: 'orca-panel-rpc', requestId: 'rpc-evil', method: 'hello.getStatus' },
      source: null
    })
    // Deterministic gate: a genuine request still resolves, proving the evil
    // frames produced no dispatch and no reply.
    const genuine = harness.waitFor('rpc-genuine')
    harness.handler({
      data: { type: 'orca-panel-rpc', requestId: 'rpc-genuine', method: 'hello.getStatus' },
      source: harness.panelWindow
    })
    await expect(genuine).resolves.toMatchObject({ requestId: 'rpc-genuine', ok: true })
    expect(seenContexts).toHaveLength(1)
    expect(harness.panelWindow.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'rpc-evil' }),
      expect.anything()
    )
    expect(otherWindow.postMessage).not.toHaveBeenCalled()
  })

  it('rejects an oversized panel RPC without worker dispatch', async () => {
    const { service, ownerKey, sessionToken, seenContexts } = await createE2EService()
    const harness = createE2EPanelHarness({ service, ownerKey, sessionToken })
    const resultPromise = harness.waitFor('rpc-big')
    harness.handler({
      data: {
        type: 'orca-panel-rpc',
        requestId: 'rpc-big',
        method: 'hello.getStatus',
        params: { padding: 'x'.repeat(128 * 1024) }
      },
      source: harness.panelWindow
    })
    await expect(resultPromise).resolves.toMatchObject({
      requestId: 'rpc-big',
      ok: false,
      errorCode: 'invalid_request'
    })
    expect(seenContexts).toHaveLength(0)
  })

  it('delivers a bounded unavailable result when the worker exits', async () => {
    // Handler throws are always handler_failure regardless of their text,
    // so the exit path rejects with the typed worker_exit failure instead.
    const { service, ownerKey, sessionToken } = await createE2EService({
      workerExitMessage: '[plugin:orca-samples.alpha] worker exited before responding'
    })
    const harness = createE2EPanelHarness({ service, ownerKey, sessionToken })
    const resultPromise = harness.waitFor('rpc-crash')
    harness.handler({
      data: { type: 'orca-panel-rpc', requestId: 'rpc-crash', method: 'hello.getStatus' },
      source: harness.panelWindow
    })
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('unavailable')
    expect(typeof result.error).toBe('string')
  })

  it('drops a deferred result after the panel document is replaced', async () => {
    const { service, ownerKey, sessionToken } = await createE2EService()
    let active = true
    let releaseRpc!: (outcome: PluginPanelRpcOutcome) => void
    const gatedRpc = vi.fn(
      () => new Promise<PluginPanelRpcOutcome>((resolve) => (releaseRpc = resolve))
    )
    const harness = createE2EPanelHarness({
      service,
      ownerKey,
      sessionToken,
      callPanelRpc: gatedRpc,
      isActive: () => active
    })
    harness.handler({
      data: { type: 'orca-panel-rpc', requestId: 'rpc-stale', method: 'hello.getStatus' },
      source: harness.panelWindow
    })
    expect(gatedRpc).toHaveBeenCalledTimes(1)
    active = false
    releaseRpc({ ok: true, value: { stale: true } })
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.panelWindow.postMessage).not.toHaveBeenCalled()
    // The service layer itself is unaffected; only the replaced document drops.
    expect(service).toBeDefined()
  })
})

describe('ORPC-4 hello-orca sample contract', () => {
  it('registers hello.getStatus and never echoes the filesystem path', async () => {
    const workerSource = await readFile(
      join(process.cwd(), 'examples/plugins/hello-orca/main.mjs'),
      'utf8'
    )
    expect(workerSource).toContain("orca.rpc.register('hello.getStatus'")
    expect(workerSource).toContain('branch: context.worktree.branch')
    expect(workerSource).toContain('displayName: context.worktree.displayName')
    // The sample must not forward the privileged path into panel output.
    expect(workerSource).not.toMatch(/worktree\.path/)
    expect(workerSource).not.toContain('context.worktree.path')

    const panelSource = await readFile(
      join(process.cwd(), 'examples/plugins/hello-orca/panel.html'),
      'utf8'
    )
    expect(panelSource).toContain('orca-panel-rpc')
    expect(panelSource).toContain('hello.getStatus')
    expect(panelSource).toContain('orca-panel-rpc-result')
    expect(panelSource).not.toContain('allow-same-origin')
  })
})
