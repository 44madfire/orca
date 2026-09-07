import { describe, expect, it } from 'vitest'
import { nativeChatPageFixture } from './mobile-web-native-chat-test-fixture'
import { bindMobileWebNativeChat } from './mobile-web-native-chat-binding'
import { MOBILE_WEB_TERMINAL_ACTION_METHODS } from './mobile-web-terminal-actions'
import { mobileWebSessionSnapshot } from './mobile-web-session-snapshot'
import { mobileWebSessionResources } from './mobile-web-session-resources'
import {
  registerMobileWebPageResource,
  resolveMobileWebPageResource
} from './mobile-web-page-resources'

function terminal(index: number) {
  return {
    id: `tab-${index}`,
    type: 'terminal',
    status: 'ready',
    terminal: `terminal-${index}`,
    agentStatus: {
      agentType: 'codex',
      providerSession: { id: `session-${index}`, transcriptPath: `/transcript-${index}` }
    }
  }
}

const [bindTerminal] = MOBILE_WEB_TERMINAL_ACTION_METHODS

describe('production host resource retirement', () => {
  it('reclaims 600 closed browser/chat/terminal identities while retaining a live identity and unrelated workspace', async () => {
    const f = nativeChatPageFixture()
    const resources = mobileWebSessionResources(f.context, f.scope.pageSession)
    const live = terminal(-1)
    const other = registerMobileWebPageResource(f.context, 'page', {
      kind: 'terminal',
      workspace: 'id:unrelated',
      identity: 'other',
      value: 42
    })
    let firstChat = ''
    let firstTerminal = ''
    let firstBrowser = ''
    let liveChat = ''
    let liveTerminal = ''
    for (let index = 0; index < 600; index++) {
      const tab = terminal(index)
      const snapshot = {
        worktree: 'host-workspace',
        publicationEpoch: 'epoch',
        snapshotVersion: index + 1,
        tabs: [
          live,
          tab,
          { id: `browser-${index}`, type: 'browser', browserPageId: `browser-${index}` }
        ]
      }
      f.listMobileSessionTabs.mockResolvedValue(snapshot)
      const projected = mobileWebSessionSnapshot(
        snapshot,
        'host-workspace',
        'workspace',
        resources.browser,
        resources.nativeChat
      )
      const chat = await bindMobileWebNativeChat(f.context, { ...f.scope, tabId: tab.id })
      const boundTerminal = (await bindTerminal.handler(
        { ...f.scope, tabId: tab.id },
        f.context
      )) as { resourceId: string }
      const currentLiveChat = await bindMobileWebNativeChat(f.context, {
        ...f.scope,
        tabId: live.id
      })
      const currentLiveTerminal = (await bindTerminal.handler(
        { ...f.scope, tabId: live.id },
        f.context
      )) as { resourceId: string }
      const projectedChat = projected.tabs.find((entry) => entry.id === tab.id)
      expect(projectedChat).toMatchObject({ nativeChatSessionId: chat.resourceId })
      if (index === 0) {
        firstChat = chat.resourceId
        firstTerminal = boundTerminal.resourceId
        firstBrowser = projected.tabs.find((entry) => entry.type === 'browser')!.id
        liveChat = currentLiveChat.resourceId
        liveTerminal = currentLiveTerminal.resourceId
      } else {
        expect(currentLiveChat.resourceId).toBe(liveChat)
        expect(currentLiveTerminal.resourceId).toBe(liveTerminal)
      }
    }
    for (const [kind, id] of [
      ['sessionChat', firstChat],
      ['terminal', firstTerminal],
      ['browser', firstBrowser]
    ]) {
      expect(() =>
        resolveMobileWebPageResource(f.context, 'page', f.scope.worktree, kind, id)
      ).toThrow('selector_not_found')
    }
    expect(resolveMobileWebPageResource(f.context, 'page', 'id:unrelated', 'terminal', other)).toBe(
      42
    )
    expect(
      resolveMobileWebPageResource(f.context, 'page', f.scope.worktree, 'sessionChat', liveChat)
    ).toMatchObject({ hostTabId: live.id })
  })

  it('does not mistake unavailable SSH inventory for retirement', async () => {
    const f = nativeChatPageFixture()
    const resources = mobileWebSessionResources(f.context, 'page')
    f.listMobileSessionTabs.mockResolvedValue({
      worktree: 'host-workspace',
      publicationEpoch: 'epoch',
      snapshotVersion: 1,
      tabs: [terminal(1)]
    })
    const chat = await bindMobileWebNativeChat(f.context, { ...f.scope, tabId: 'tab-1' })
    const terminalId = (await bindTerminal.handler({ ...f.scope, tabId: 'tab-1' }, f.context)) as {
      resourceId: string
    }
    const unavailable = {
      worktree: 'host-workspace',
      publicationEpoch: 'epoch',
      snapshotVersion: 2,
      workspaceTransportState: 'unavailable',
      tabs: []
    }
    f.listMobileSessionTabs.mockResolvedValue(unavailable)
    mobileWebSessionSnapshot(
      unavailable,
      'host-workspace',
      'workspace',
      resources.browser,
      resources.nativeChat
    )
    await expect(
      bindMobileWebNativeChat(f.context, { ...f.scope, tabId: 'tab-1' })
    ).rejects.toThrow('selector_not_found')
    await expect(bindTerminal.handler({ ...f.scope, tabId: 'tab-1' }, f.context)).rejects.toThrow(
      'selector_not_found'
    )
    expect(
      resolveMobileWebPageResource(
        f.context,
        'page',
        f.scope.worktree,
        'sessionChat',
        chat.resourceId
      )
    ).toBeDefined()
    expect(
      resolveMobileWebPageResource(
        f.context,
        'page',
        f.scope.worktree,
        'terminal',
        terminalId.resourceId
      )
    ).toBeDefined()
  })

  it('refuses true all-active host capacity without evicting live resources', async () => {
    const f = nativeChatPageFixture()
    const tabs = Array.from({ length: 513 }, (_, index) => terminal(index))
    f.listMobileSessionTabs.mockResolvedValue({
      worktree: 'host-workspace',
      publicationEpoch: 'epoch',
      snapshotVersion: 1,
      tabs
    })
    let first = ''
    for (let index = 0; index < 512; index++) {
      const value = (await bindTerminal.handler(
        { ...f.scope, tabId: tabs[index]!.id },
        f.context
      )) as { resourceId: string }
      if (index === 0) {
        first = value.resourceId
      }
    }
    await expect(
      bindTerminal.handler({ ...f.scope, tabId: tabs[512]!.id }, f.context)
    ).rejects.toThrow('runtime_unavailable')
    expect(
      resolveMobileWebPageResource(f.context, 'page', f.scope.worktree, 'terminal', first)
    ).toMatchObject({ tabId: 'tab-0' })
  })
})
