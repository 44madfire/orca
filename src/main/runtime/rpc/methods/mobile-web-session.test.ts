import { describe, expect, it } from 'vitest'
import { MobileWebSessionSnapshotResultSchema } from '../../../../shared/mobile-web/session-operation-contract'
import { MOBILE_WEB_SESSION_METHODS } from './mobile-web-session'
import { MOBILE_WEB_SESSION_NATIVE_RESOURCE_METHOD } from './mobile-web-session-native-resource'
import { sessionFixture } from './mobile-web-session-test-fixture'
import { resolveMobileWebPageResource } from './mobile-web-page-resources'

const [snapshot, activate, close] = MOBILE_WEB_SESSION_METHODS
const resolve = MOBILE_WEB_SESSION_NATIVE_RESOURCE_METHOD

describe('host-owned session snapshots and actions', () => {
  it('retains page identities, publication fences and folder execution while hiding private bindings', async () => {
    const f = sessionFixture()
    const first = await snapshot.handler(f.params, f.context)
    const second = await snapshot.handler(f.params, f.context)
    expect(second).toEqual(first)
    expect(first).toMatchObject({
      workspaceId: 'opaque-workspace',
      publicationEpoch: 'epoch',
      snapshotVersion: 1
    })
    expect(JSON.stringify(first)).not.toContain('private')
    const tab = MobileWebSessionSnapshotResultSchema.parse(first).tabs[0]
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Missing chat')
    }
    expect(
      await resolve.handler(
        { ...f.params, kind: 'sessionChat', resourceId: tab.nativeChatSessionId },
        f.context
      )
    ).toMatchObject({ hostTerminalId: 'private-terminal', providerSessionId: 'private-session' })
    expect(f.runtime.listMobileSessionTabs).toHaveBeenCalledWith(f.params.worktree, 'device')
  })

  it('retires changed provider identities and refuses delayed snapshots without resurrecting handles', async () => {
    const f = sessionFixture()
    const initial = f.snapshot
    const first = await snapshot.handler(f.params, f.context)
    const tab = MobileWebSessionSnapshotResultSchema.parse(first).tabs[0]
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Missing chat')
    }
    f.setSnapshot({ ...initial, snapshotVersion: 2, tabs: [] })
    await snapshot.handler(f.params, f.context)
    expect(() =>
      resolveMobileWebPageResource(
        f.context,
        'page',
        f.params.worktree,
        'sessionChat',
        tab.nativeChatSessionId!
      )
    ).toThrow('selector_not_found')
    f.setSnapshot(initial)
    await expect(snapshot.handler(f.params, f.context)).rejects.toThrow('selector_not_found')
  })

  it('does not infer remote process death from failed reads', async () => {
    const f = sessionFixture()
    const first = await snapshot.handler(f.params, f.context)
    const tab = MobileWebSessionSnapshotResultSchema.parse(first).tabs[0]
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Missing chat')
    }
    f.runtime.listMobileSessionTabs.mockRejectedValueOnce(new Error('SSH unreachable'))
    await expect(
      resolve.handler(
        { ...f.params, kind: 'sessionChat', resourceId: tab.nativeChatSessionId },
        f.context
      )
    ).rejects.toThrow('SSH unreachable')
    expect(
      resolveMobileWebPageResource(
        f.context,
        'page',
        f.params.worktree,
        'sessionChat',
        tab.nativeChatSessionId
      )
    ).toBeDefined()
  })

  it('isolates native resources across page documents, workspaces, connections and runtimes', async () => {
    const f = sessionFixture()
    const result = await snapshot.handler(f.params, f.context)
    const tab = MobileWebSessionSnapshotResultSchema.parse(result).tabs[0]
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Missing chat')
    }
    const params = {
      ...f.params,
      kind: 'sessionChat' as const,
      resourceId: tab.nativeChatSessionId
    }
    for (const [input, context] of [
      [{ ...params, pageSession: 'other-page' }, f.context],
      [{ ...params, worktree: 'id:other-workspace' }, f.context],
      [params, { ...f.context, connectionId: 'other-connection' }],
      [params, sessionFixture().context]
    ] as const) {
      await expect(resolve.handler(input, context)).rejects.toThrow('selector_not_found')
    }
    for (const cleanup of f.cleanups.values()) {
      cleanup()
    }
    await expect(resolve.handler(params, f.context)).rejects.toThrow('selector_not_found')
  })

  it('uses original activation and close handlers with caller navigation and no ambiguous-result retry', async () => {
    const f = sessionFixture()
    await activate.handler({ ...f.params, tabId: 'tab' }, f.context)
    expect(f.runtime.activateMobileSessionTab).toHaveBeenCalledWith(
      f.params.worktree,
      'tab',
      undefined,
      expect.objectContaining({
        notifyClients: false,
        navigation: 'caller',
        clientNavigationId: 'device'
      })
    )
    expect(await close.handler({ ...f.params, tabId: 'tab' }, f.context)).toMatchObject({
      outcome: 'closed',
      tabId: 'tab'
    })
    f.runtime.closeMobileSessionTab.mockRejectedValueOnce(new Error('lost acknowledgement'))
    await expect(close.handler({ ...f.params, tabId: 'tab' }, f.context)).rejects.toThrow(
      'lost acknowledgement'
    )
    expect(f.runtime.closeMobileSessionTab).toHaveBeenCalledTimes(2)
  })
})
