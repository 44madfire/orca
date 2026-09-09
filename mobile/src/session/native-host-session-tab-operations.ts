import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type { HostSessionTabOperations } from './host-session-tab-operations'
import { projectHostSessionRuntimeCapabilities } from './host-session-runtime-capabilities'
import type { SessionTabsResult } from './mobile-session-route-types'
import { loadMobileNewTabAgentOptions } from './mobile-new-tab-agent-loader'
import { activateMobileSessionTab } from './mobile-session-tab-activation'

export function nativeHostSessionTabOperations(client: RpcClient): HostSessionTabOperations {
  return {
    async runtimeCapabilities() {
      const response = await client.sendRequest('status.get')
      if (!response.ok) {
        throw new Error('session_capabilities_failed')
      }
      const result = (response as RpcSuccess).result as { capabilities?: unknown }
      const capabilities = Array.isArray(result.capabilities)
        ? result.capabilities.filter((value): value is string => typeof value === 'string')
        : []
      return projectHostSessionRuntimeCapabilities(capabilities)
    },
    async snapshot(workspaceId) {
      return successfulSnapshot(
        await client.sendRequest('session.tabs.list', {
          worktree: `id:${workspaceId}`
        })
      )
    },
    subscribe(workspaceId, onSnapshot, onError) {
      return client.subscribe(
        'session.tabs.subscribe',
        { worktree: `id:${workspaceId}` },
        (payload) => {
          const event = payload as { type?: string } & SessionTabsResult
          if (event.type === 'snapshot' || event.type === 'updated') {
            onSnapshot(event)
            return
          }
          // Why: a host-side subscription cleanup ends the stream; without degrading here the
          // tab list freezes on its last snapshot and never refetches.
          if (event.type === 'end' || event.type === 'error') {
            onError()
          }
        }
      )
    },
    agentOptions(workspaceId) {
      return loadMobileNewTabAgentOptions({ client, worktreeId: workspaceId })
    },
    async createBrowser(workspaceId, url) {
      const response = await client.sendRequest(
        'browser.tabCreate',
        { worktree: `id:${workspaceId}`, url, activate: true },
        { timeoutMs: 30_000 }
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      // A host that answers without a page id still created the tab; the caller only loses the
      // focus hint, so this is not a create failure.
      const result = (response as RpcSuccess).result as { browserPageId?: unknown }
      return typeof result.browserPageId === 'string' ? { browserPageId: result.browserPageId } : {}
    },
    async activate(workspaceId, tabId, leafId) {
      // Why: a relay-to-direct cutover rejects the in-flight request; activation is idempotent,
      // so retrying once keeps the host's active tab in step with the UI the user just switched.
      return successfulSnapshot(
        await activateMobileSessionTab(client, {
          worktree: `id:${workspaceId}`,
          tabId,
          ...(leafId ? { leafId } : {}),
          notifyClients: false,
          navigation: 'caller',
          intent: 'user'
        })
      )
    },
    async close(workspaceId, tabId) {
      const response = await client.sendRequest('session.tabs.close', {
        worktree: `id:${workspaceId}`,
        tabId,
        reason: 'user'
      })
      if (!response.ok) {
        throw new Error('session_close_failed')
      }
      const result = (response as RpcSuccess).result as {
        closed?: boolean
        refused?: boolean
        refusalReason?: string
      }
      if (result.closed !== true) {
        throw new Error('session_close_failed')
      }
      return result.refused
        ? { outcome: 'refused', reason: result.refusalReason ?? null }
        : { outcome: 'closed' }
    }
  }
}

function successfulSnapshot(response: Awaited<ReturnType<RpcClient['sendRequest']>>) {
  if (!response.ok) {
    throw new Error('session_snapshot_failed')
  }
  return (response as RpcSuccess).result as SessionTabsResult
}
