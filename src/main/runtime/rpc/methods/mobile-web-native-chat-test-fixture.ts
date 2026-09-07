import { openMobileWebPageResources } from './mobile-web-page-resources'
import { vi, type Mock } from 'vitest'
import type { RpcContext } from '../core'
export function nativeChatPageFixture(): {
  context: RpcContext
  scope: { worktree: string; pageSession: string }
  listMobileSessionTabs: Mock
  tab: Record<string, unknown>
} {
  const tab = {
    id: 'tab',
    type: 'terminal',
    terminal: 'host-terminal',
    agentStatus: {
      agentType: 'codex',
      providerSession: { id: 'provider-session', transcriptPath: '/private/transcript' }
    }
  }
  const listMobileSessionTabs = vi
    .fn()
    .mockResolvedValue({
      worktree: 'host-workspace',
      publicationEpoch: 'epoch',
      snapshotVersion: 1,
      tabs: [tab]
    })
  const context = {
    connectionId: 'connection',
    clientId: 'authenticated-device-token',
    pairedDeviceId: 'device',
    runtime: { listMobileSessionTabs, registerSubscriptionCleanup: vi.fn() }
  } as unknown as RpcContext
  openMobileWebPageResources(context, 'page')
  const scope = { worktree: 'id:host-workspace', pageSession: 'page' }
  return { context, scope, listMobileSessionTabs, tab }
}
