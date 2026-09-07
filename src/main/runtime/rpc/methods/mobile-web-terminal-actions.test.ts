import { openMobileWebPageResources } from './mobile-web-page-resources'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { MOBILE_WEB_TERMINAL_ACTION_METHODS } from './mobile-web-terminal-actions'
import { MOBILE_WEB_HOST_CATALOG_METHOD } from './mobile-web-host-catalog'

const [bind, action] = MOBILE_WEB_TERMINAL_ACTION_METHODS
function fixture(worktree = 'folder:workspace') {
  const tab = { id: 'tab', type: 'terminal', status: 'ready', terminal: 'private-terminal' }
  const runtime = {
    listMobileSessionTabs: vi
      .fn()
      .mockResolvedValue({ worktree, publicationEpoch: 'epoch', snapshotVersion: 1, tabs: [tab] }),
    registerSubscriptionCleanup: vi.fn(),
    renameTerminal: vi.fn().mockResolvedValue({ handle: 'private-terminal' }),
    clearTerminalBuffer: vi.fn().mockResolvedValue({ handle: 'private-terminal' }),
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'remote-pty' }),
    updateMobileSubscriberViewport: vi.fn(),
    markMobileActor: vi.fn(),
    setMobileDisplayMode: vi.fn(),
    applyMobileDisplayMode: vi.fn(),
    getLayout: vi.fn()
  }
  const context = {
    runtime,
    connectionId: 'connection',
    clientId: 'authenticated',
    pairedDeviceId: 'device'
  } as unknown as RpcContext
  openMobileWebPageResources(context, 'page')
  const scope = { worktree: `id:${worktree}`, pageSession: 'page', timeoutMs: 15_000 }
  async function bound() {
    return (await bind.handler({ ...scope, tabId: 'tab' }, context)) as { resourceId: string }
  }
  return { context, runtime, scope, tab, bound }
}

afterEach(() => vi.useRealTimers())

describe('host-owned terminal metadata', () => {
  it.each(['folder:workspace', 'ssh-workspace'])(
    'binds %s through the owning runtime without exposing terminal handles',
    async (workspace) => {
      const f = fixture(workspace)
      const resource = await f.bound()
      expect(resource.resourceId).toMatch(/^resource_/)
      expect(f.runtime.listMobileSessionTabs).toHaveBeenCalledWith(f.scope.worktree, 'device')
      for (const method of ['terminal.rename', 'terminal.clearBuffer']) {
        expect(
          await action.handler(
            { ...f.scope, ...resource, method, fields: { title: 'Build', terminal: 'forged' } },
            f.context
          )
        ).toEqual({ applied: true })
      }
      expect(f.runtime.renameTerminal).toHaveBeenCalledWith('private-terminal', 'Build')
      expect(f.runtime.clearTerminalBuffer).toHaveBeenCalledWith('private-terminal')
    }
  )
  it('uses the authenticated mobile actor and existing viewport driver', async () => {
    const f = fixture()
    const resource = await f.bound()
    await action.handler(
      {
        ...f.scope,
        ...resource,
        method: 'terminal.setDisplayMode',
        fields: { mode: 'auto', viewport: { cols: 90, rows: 30 }, client: { id: 'forged' } }
      },
      f.context
    )
    expect(f.runtime.updateMobileSubscriberViewport).toHaveBeenCalledWith(
      'remote-pty',
      'authenticated',
      { cols: 90, rows: 30 }
    )
    expect(f.runtime.markMobileActor).toHaveBeenCalledWith('remote-pty', 'authenticated')
    expect(f.runtime.applyMobileDisplayMode).toHaveBeenCalledWith('remote-pty')
  })
  it('refuses replaced, missing, nonready and cross-scope terminal bindings before mutation', async () => {
    const f = fixture()
    const resource = await f.bound()
    const params = { ...f.scope, ...resource, method: 'terminal.clearBuffer', fields: {} }
    for (const tabs of [
      [{ ...f.tab, terminal: 'replacement' }],
      [],
      [{ ...f.tab, status: 'pending-handle' }]
    ]) {
      f.runtime.listMobileSessionTabs.mockResolvedValue({ worktree: 'folder:workspace', tabs })
      await expect(action.handler(params, f.context)).rejects.toThrow('selector_not_found')
    }
    for (const changed of [{ pageSession: 'other' }, { worktree: 'id:other' }]) {
      await expect(action.handler({ ...params, ...changed }, f.context)).rejects.toThrow(
        'selector_not_found'
      )
    }
    await expect(action.handler(params, { ...f.context, connectionId: 'other' })).rejects.toThrow(
      'selector_not_found'
    )
    expect(f.runtime.clearTerminalBuffer).not.toHaveBeenCalled()
  })
  it('does not dispatch after disconnect during identity lookup, and never retries handler failures', async () => {
    const f = fixture()
    const resource = await f.bound()
    const params = { ...f.scope, ...resource, method: 'terminal.clearBuffer', fields: {} }
    const controller = new AbortController()
    f.runtime.listMobileSessionTabs.mockImplementationOnce(async () => {
      controller.abort()
      return {
        worktree: 'folder:workspace',
        publicationEpoch: 'epoch',
        snapshotVersion: 1,
        tabs: [f.tab]
      }
    })
    await expect(
      action.handler(params, { ...f.context, signal: controller.signal })
    ).rejects.toThrow('runtime_unavailable')
    expect(f.runtime.clearTerminalBuffer).not.toHaveBeenCalled()
    f.runtime.clearTerminalBuffer.mockRejectedValueOnce(new Error('lost acknowledgement'))
    await expect(action.handler(params, f.context)).rejects.toThrow('lost acknowledgement')
    expect(f.runtime.clearTerminalBuffer).toHaveBeenCalledOnce()
  })
  it('expires a delayed identity lookup without changing the terminal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const f = fixture()
    const resource = await f.bound()
    f.runtime.listMobileSessionTabs.mockImplementationOnce(async () => {
      vi.setSystemTime(20_000)
      return {
        worktree: 'folder:workspace',
        publicationEpoch: 'epoch',
        snapshotVersion: 1,
        tabs: [f.tab]
      }
    })
    await expect(
      action.handler(
        { ...f.scope, ...resource, method: 'terminal.clearBuffer', fields: {} },
        f.context
      )
    ).rejects.toThrow('runtime_unavailable')
    expect(f.runtime.clearTerminalBuffer).not.toHaveBeenCalled()
  })
  it('advertises both methods with host page-session authority', async () => {
    expect(
      await MOBILE_WEB_HOST_CATALOG_METHOD.handler(
        { methods: MOBILE_WEB_TERMINAL_ACTION_METHODS.map((method) => method.name) },
        {} as RpcContext
      )
    ).toEqual({
      grants: MOBILE_WEB_TERMINAL_ACTION_METHODS.map((method) => ({
        method: method.name,
        workspaceParam: 'worktree',
        pageSessionParam: 'pageSession',
        maxRequestBytes: 16 * 1024,
        maxResponseBytes: 512 * 1024
      }))
    })
  })
})
