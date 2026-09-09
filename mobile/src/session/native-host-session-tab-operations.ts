import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type { HostSessionTabOperations } from './host-session-tab-operations'

export function nativeHostSessionTabOperations(client: RpcClient): HostSessionTabOperations {
  return {
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
