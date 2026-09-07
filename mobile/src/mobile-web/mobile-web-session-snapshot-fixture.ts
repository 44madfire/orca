import { MobileWebRelativePathSchema } from '../../../src/shared/mobile-web/bridge-operation-contract'
import { mobileWebPageBrowserUrl } from '../../../src/shared/mobile-web/browser-url-privacy'

type RecordValue = Record<string, unknown>

// Serialized Desktop responses for mobile transport tests; host projection tests live in the root suite.
export class SessionSnapshotFixture {
  private bindings = new Map<string, { scope: string; kind: string; value: RecordValue }>()
  private keys = new Map<string, string>()
  private next = 0

  register(page: string, workspace: string, kind: string, value: RecordValue): string {
    const scope = JSON.stringify([page, workspace])
    const key = JSON.stringify([scope, kind, value])
    const id = this.keys.get(key) ?? `resource_fixture_${this.next++}`
    this.keys.set(key, id)
    this.bindings.set(id, { scope, kind, value })
    return id
  }

  resolve(page: string, workspace: string, kind: string, id: string): RecordValue {
    const binding = this.bindings.get(id)
    if (!binding || binding.scope !== JSON.stringify([page, workspace]) || binding.kind !== kind) {
      throw new Error('selector_not_found')
    }
    return binding.value
  }

  project(value: unknown, page: string, workspace: string, workspaceId: string) {
    const source = value as RecordValue
    if (source.worktree !== workspace.slice(3) || !Array.isArray(source.tabs)) {
      throw new Error('invalid snapshot fixture')
    }
    const ids = new Set<string>()
    const tabs = source.tabs.map((tab: RecordValue) => {
      const base: RecordValue = {
        id: tab.id,
        type: tab.type,
        title: tab.title,
        isActive: tab.isActive === true
      }
      if (tab.type === 'terminal') {
        base.status = tab.status === 'pending-handle' ? 'pending-handle' : 'ready'
        if (tab.launchAgent) {
          base.launchAgent = tab.launchAgent
        }
        const agent = tab.agentStatus as RecordValue | undefined
        if (agent?.state) {
          base.agentStatus = Object.fromEntries(
            Object.entries(agent).filter(([key]) =>
              [
                'state',
                'stateStartedAt',
                'agentType',
                'model',
                'toolName',
                'toolInput',
                'interactivePrompt',
                'lastAssistantMessage',
                'lastAssistantMessageIsToolOutput',
                'workingMode',
                'interrupted'
              ].includes(key)
            )
          )
        }
        const provider = agent?.providerSession as RecordValue | undefined
        if (provider?.id) {
          const id = this.register(page, workspace, 'sessionChat', {
            hostWorkspaceId: source.worktree,
            hostTabId: tab.id,
            hostTerminalId: tab.terminal ?? null,
            agent: agent?.agentType ?? tab.launchAgent,
            providerSessionId: provider.id,
            ...(provider.transcriptPath ? { transcriptPath: provider.transcriptPath } : {})
          })
          base.nativeChatSessionId = id
          ids.add(id)
        }
      } else if (tab.type === 'browser') {
        const id = this.register(page, workspace, 'browser', {
          hostWorkspaceId: source.worktree,
          hostPageId: tab.browserPageId
        })
        ids.add(id)
        Object.assign(base, {
          id,
          browserPageId: id,
          url: mobileWebPageBrowserUrl(tab.url),
          loading: tab.loading === true,
          canGoBack: tab.canGoBack === true,
          canGoForward: tab.canGoForward === true
        })
      } else {
        const path = MobileWebRelativePathSchema.safeParse(tab.relativePath)
        if (path.success) {
          base.relativePath = path.data
        }
        for (const key of ['language', 'mode', 'diffSource']) {
          if (tab[key] !== undefined) {
            base[key] = tab[key]
          }
        }
        if (tab.type === 'markdown') {
          base.isDirty = tab.isDirty === true
        }
      }
      return base
    })
    for (const [id, binding] of this.bindings) {
      if (binding.scope === JSON.stringify([page, workspace]) && !ids.has(id)) {
        this.bindings.delete(id)
      }
    }
    return {
      workspaceId,
      publicationEpoch: source.publicationEpoch,
      snapshotVersion: source.snapshotVersion,
      workspaceTransportState:
        source.workspaceTransportState === 'unavailable' ? 'unavailable' : 'available',
      activeTabId:
        source.activeTabType === 'browser'
          ? (tabs.find((tab: RecordValue) => tab.type === 'browser' && tab.isActive)?.id ?? null)
          : (source.activeTabId ?? null),
      activeTabType: source.activeTabType ?? null,
      tabs,
      truncated: false
    }
  }
}
