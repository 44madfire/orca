import type { RpcClient } from '../transport/rpc-client'
import { SessionSnapshotFixture } from './mobile-web-session-snapshot-fixture'

// Fake Desktop transport for legacy RPC fixtures; page requests still traverse the generic broker.
export function sessionHostFixture(client: RpcClient): RpcClient {
  const snapshots = new SessionSnapshotFixture()
  const reply = (result: unknown) => ({
    id: 'fixture',
    _meta: { runtimeId: 'fixture' },
    ok: true as const,
    result
  })
  return new Proxy(client, {
    get(target, key) {
      if (key === 'subscribe') {
        return (
          method: string,
          input: Record<string, unknown>,
          listener: (event: unknown) => void,
          options?: unknown
        ) => {
          if (method === 'mobileWeb.page.subscribe') {
            listener({ type: 'ready', subscriptionId: input.pageSession })
            return () => {}
          }
          if (method !== 'mobileWeb.session.subscribe') {
            return target.subscribe(method, input, listener, options as never)
          }
          return target.subscribe(
            'session.tabs.subscribe',
            { worktree: input.worktree },
            (event) => {
              try {
                listener({
                  type: 'snapshot',
                  snapshot: snapshots.project(
                    event,
                    String(input.pageSession),
                    String(input.worktree),
                    String(input.workspaceId)
                  )
                })
              } catch {
                listener({ type: 'error', message: 'invalid snapshot fixture' })
              }
            }
          )
        }
      }
      if (key !== 'sendRequest') {
        return Reflect.get(target, key)
      }
      return async (method: string, input: Record<string, unknown>, options?: unknown) => {
        if (
          method === 'mobileWeb.host.catalog' &&
          Array.isArray(input.methods) &&
          input.methods.every((name) => String(name).startsWith('mobileWeb.session.'))
        ) {
          return reply({
            grants: input.methods.map((method) => ({
              method,
              ...(method === 'mobileWeb.session.subscribe'
                ? { mode: 'subscription', unsubscribeMethod: 'mobileWeb.session.unsubscribe' }
                : {}),
              workspaceParam: 'worktree',
              pageSessionParam: 'pageSession',
              maxRequestBytes: 16384,
              maxResponseBytes: 524288
            }))
          })
        }
        if (method === 'mobileWeb.session.snapshot' || method === 'mobileWeb.session.activate') {
          const response = await target.sendRequest(
            method === 'mobileWeb.session.snapshot' ? 'session.tabs.list' : 'session.tabs.activate',
            {
              worktree: input.worktree,
              ...(method === 'mobileWeb.session.activate'
                ? { tabId: input.tabId, notifyClients: false, navigation: 'caller' }
                : {})
            }
          )
          if (!response.ok) {
            return response
          }
          return reply(
            snapshots.project(
              response.result,
              String(input.pageSession),
              String(input.worktree),
              String(input.workspaceId)
            )
          )
        }
        if (method === 'mobileWeb.session.createBrowser') {
          const response = await target.sendRequest('browser.tabCreate', {
            worktree: input.worktree,
            url: input.url,
            activate: true
          })
          if (!response.ok) {
            return response
          }
          const result = response.result as { browserPageId: string }
          return reply({
            workspaceId: input.workspaceId,
            browserPageId: snapshots.register(
              String(input.pageSession),
              String(input.worktree),
              'browser',
              { hostWorkspaceId: String(input.worktree).slice(3), hostPageId: result.browserPageId }
            )
          })
        }
        if (method === 'mobileWeb.session.close') {
          const response = await target.sendRequest('session.tabs.close', {
            worktree: input.worktree,
            tabId: input.tabId,
            reason: 'user'
          })
          if (!response.ok) {
            return response
          }
          return reply({
            workspaceId: input.workspaceId,
            tabId: input.tabId,
            outcome: 'closed',
            refusalReason: null
          })
        }
        if (method === 'mobileWeb.resource.resolve') {
          const value = snapshots.resolve(
            String(input.pageSession),
            String(input.worktree),
            String(input.kind),
            String(input.resourceId)
          )
          if (input.kind === 'sessionChat') {
            const response = await target.sendRequest('session.tabs.list', {
              worktree: input.worktree
            })
            if (!response.ok) {
              return response
            }
            snapshots.project(
              response.result,
              String(input.pageSession),
              String(input.worktree),
              'fixture'
            )
            snapshots.resolve(
              String(input.pageSession),
              String(input.worktree),
              String(input.kind),
              String(input.resourceId)
            )
          }
          return reply(value)
        }
        return options === undefined
          ? target.sendRequest(method, input)
          : target.sendRequest(method, input, options as never)
      }
    }
  })
}
