import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { createPluginPanelCallAdmission } from '../../shared/plugins/plugin-panel-call-admission'
import type { PluginPanelRpcOutcome } from '../../shared/plugins/plugin-panel-bridge'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginPanelController } from './plugin-panel-controller'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createPlugin(publisher: string, id: string): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-panel-rpc-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'panel.html'), '<h1>Panel</h1>')
  return {
    pluginKey: `${publisher}.${id}`,
    rootDir,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id,
      publisher,
      name: id,
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {
        panels: [{ id: 'dashboard', title: 'Dashboard', entry: 'panel.html' }],
        commands: [],
        events: []
      },
      capabilities: []
    }),
    consentFingerprint: 'sha256-consented',
    contentHash: null,
    isDev: true
  }
}

function controllerFor(
  plugins: ValidDiscoveredPlugin[],
  executeRpc: (
    pluginKey: string,
    panelId: string,
    method: string,
    params: unknown
  ) => Promise<PluginPanelRpcOutcome>,
  options: { resolveApproved?: (pluginKey: string) => ValidDiscoveredPlugin | null } = {}
): PluginPanelController {
  const byKey = new Map(plugins.map((plugin) => [plugin.pluginKey, plugin]))
  return new PluginPanelController({
    resolveApprovedPlugin: options.resolveApproved ?? ((pluginKey) => byKey.get(pluginKey) ?? null),
    contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
    executeHostCall: vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }),
    executeRpc: vi.fn(executeRpc),
    log: vi.fn()
  })
}

describe('PluginPanelController.executeRpc session binding', () => {
  it('invokes only the session-bound plugin worker; params cannot retarget', async () => {
    const pluginA = await createPlugin('orca-samples', 'alpha')
    const pluginB = await createPlugin('orca-samples', 'beta')
    const executeRpc = vi.fn(async () => ({ ok: true, value: { echoed: true } }) as const)
    const controller = controllerFor([pluginA, pluginB], executeRpc)
    const entryA = await controller.open('runtime:one', pluginA.pluginKey, 'dashboard')
    expect(entryA).not.toBeNull()

    await expect(
      controller.executeRpc('runtime:one', {
        sessionToken: entryA!.sessionToken,
        method: 'panel.echo',
        params: { hello: 'world' }
      })
    ).resolves.toEqual({ ok: true, value: { echoed: true } })
    expect(executeRpc).toHaveBeenCalledWith(pluginA.pluginKey, 'dashboard', 'panel.echo', {
      hello: 'world'
    })

    // No panel-supplied field changes the target: strict schema rejects them.
    for (const call of [
      {
        sessionToken: entryA!.sessionToken,
        method: 'panel.echo',
        pluginKey: pluginB.pluginKey
      },
      {
        sessionToken: entryA!.sessionToken,
        method: 'panel.echo',
        pluginId: pluginB.pluginKey
      },
      { sessionToken: entryA!.sessionToken, method: 'panel.echo', panelId: 'other' }
    ]) {
      await expect(controller.executeRpc('runtime:one', call)).resolves.toMatchObject({
        ok: false,
        code: 'invalid_request'
      })
    }
    expect(executeRpc).toHaveBeenCalledTimes(1)
  })

  it('rejects wrong-owner, revoked, and rotated sessions', async () => {
    const plugin = await createPlugin('orca-samples', 'alpha')
    const controller = controllerFor(
      [plugin],
      vi.fn(async () => ({ ok: true, value: null }) as const)
    )
    const entry = await controller.open('runtime:one', plugin.pluginKey, 'dashboard')

    await expect(
      controller.executeRpc('runtime:other', {
        sessionToken: entry!.sessionToken,
        method: 'panel.echo'
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })

    controller.revokeOwner('runtime:one')
    await expect(
      controller.executeRpc('runtime:one', {
        sessionToken: entry!.sessionToken,
        method: 'panel.echo'
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })
  })

  it('rejects a replayed token after the session rotates on manifest change', async () => {
    const plugin = await createPlugin('orca-samples', 'alpha')
    let current: ValidDiscoveredPlugin | null = plugin
    const executeRpc = vi.fn(async () => ({ ok: true, value: null }) as const)
    const controller = controllerFor([plugin], executeRpc, {
      resolveApproved: () => current
    })
    const first = await controller.open('runtime:one', plugin.pluginKey, 'dashboard')

    current = {
      ...plugin,
      manifest: pluginManifestSchema.parse({ ...plugin.manifest, version: '1.0.1' })
    }
    const second = await controller.open('runtime:one', plugin.pluginKey, 'dashboard')
    expect(second!.sessionToken).not.toBe(first!.sessionToken)

    // The old token still resolves but its binding is stale, so it is rejected.
    await expect(
      controller.executeRpc('runtime:one', {
        sessionToken: first!.sessionToken,
        method: 'panel.echo'
      })
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    // The rotated-in token carries the fresh binding and still dispatches.
    await expect(
      controller.executeRpc('runtime:one', {
        sessionToken: second!.sessionToken,
        method: 'panel.echo'
      })
    ).resolves.toMatchObject({ ok: true })
    expect(executeRpc).toHaveBeenCalledTimes(1)
  })

  it('invalidates calls after manifest/root changes and plugin disable', async () => {
    const plugin = await createPlugin('orca-samples', 'alpha')
    let current: ValidDiscoveredPlugin | null = plugin
    const executeRpc = vi.fn(async () => ({ ok: true, value: null }) as const)
    const controller = controllerFor([plugin], executeRpc, {
      resolveApproved: () => current
    })
    const entry = await controller.open('runtime:one', plugin.pluginKey, 'dashboard')

    current = {
      ...plugin,
      manifest: pluginManifestSchema.parse({ ...plugin.manifest, version: '1.0.1' })
    }
    await expect(
      controller.executeRpc('runtime:one', {
        sessionToken: entry!.sessionToken,
        method: 'panel.echo'
      })
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })

    current = null
    await expect(
      controller.executeRpc('runtime:one', {
        sessionToken: entry!.sessionToken,
        method: 'panel.echo'
      })
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(executeRpc).not.toHaveBeenCalled()
  })

  it('shares the admission budget between actions and RPC', async () => {
    const plugin = await createPlugin('orca-samples', 'alpha')
    const controller = new PluginPanelController({
      resolveApprovedPlugin: () => plugin,
      contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
      executeHostCall: vi.fn().mockResolvedValue({ ok: true, value: null }),
      executeRpc: vi.fn(async () => ({ ok: true, value: null }) as const),
      log: vi.fn(),
      panelAdmission: createPluginPanelCallAdmission({
        limits: { maxMessages: 2, perMs: 10_000 },
        now: () => 0
      })
    })
    const entry = await controller.open('runtime:one', plugin.pluginKey, 'dashboard')

    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'notifications.show',
        params: { title: 'one' }
      })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      controller.executeRpc('runtime:one', {
        sessionToken: entry!.sessionToken,
        method: 'panel.echo'
      })
    ).resolves.toMatchObject({ ok: true })
    // The shared per-plugin budget is exhausted: RPC cannot bypass it.
    await expect(
      controller.executeRpc('runtime:one', {
        sessionToken: entry!.sessionToken,
        method: 'panel.echo'
      })
    ).resolves.toEqual({
      ok: false,
      code: 'rate_limited',
      error: 'too many panel requests'
    })
  })

  it('rejects malformed methods and oversized payloads before dispatch', async () => {
    const plugin = await createPlugin('orca-samples', 'alpha')
    const executeRpc = vi.fn(async () => ({ ok: true, value: null }) as const)
    const controller = controllerFor([plugin], executeRpc)
    const entry = await controller.open('runtime:one', plugin.pluginKey, 'dashboard')

    await expect(
      controller.executeRpc('runtime:one', { sessionToken: entry!.sessionToken, method: '' })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })
    await expect(
      controller.executeRpc('runtime:one', {
        sessionToken: entry!.sessionToken,
        method: 'panel.echo',
        params: { padding: 'x'.repeat(128 * 1024) }
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })
    expect(executeRpc).not.toHaveBeenCalled()
  })
})
