import { randomUUID } from 'node:crypto'
import type { RpcContext } from '../core'

type Resource = { kind: string; workspace: string; identity: string; value: unknown }
type PageResources = { resources: Map<string, Resource>; keys: Map<string, string> }
const runtimes = new WeakMap<RpcContext['runtime'], Map<string, PageResources>>()

function pageResources(context: RpcContext, pageSession: string): PageResources {
  if (!context.connectionId || !pageSession || pageSession.length > 160) {
    throw new Error('selector_not_found')
  }
  let pages = runtimes.get(context.runtime)
  if (!pages) {
    pages = new Map()
    runtimes.set(context.runtime, pages)
  }
  const key = JSON.stringify([context.connectionId, pageSession])
  const existing = pages.get(key)
  if (existing) {
    return existing
  }
  if (pages.size >= 128) {
    throw new Error('runtime_unavailable')
  }
  const page = { resources: new Map<string, Resource>(), keys: new Map<string, string>() }
  pages.set(key, page)
  context.runtime.registerSubscriptionCleanup(
    `mobileWeb.page:${randomUUID()}`,
    () => {
      pages?.delete(key)
    },
    context.connectionId
  )
  return page
}

export function registerMobileWebPageResource<T>(
  context: RpcContext,
  pageSession: string,
  resource: Resource & { value: T }
): string {
  const page = pageResources(context, pageSession)
  const key = JSON.stringify([resource.kind, resource.workspace, resource.identity])
  const existing = page.keys.get(key)
  if (existing) {
    return existing
  }
  if (page.resources.size >= 512) {
    throw new Error('runtime_unavailable')
  }
  const handle = `resource_${randomUUID()}`
  page.resources.set(handle, resource)
  page.keys.set(key, handle)
  return handle
}

export function resolveMobileWebPageResource<T>(
  context: RpcContext,
  pageSession: string,
  workspace: string,
  kind: string,
  handle: string
): T {
  const resource = pageResources(context, pageSession).resources.get(handle)
  if (!resource || resource.workspace !== workspace || resource.kind !== kind) {
    throw new Error('selector_not_found')
  }
  return resource.value as T
}
