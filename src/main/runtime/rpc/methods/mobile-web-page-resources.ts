import { randomUUID } from 'node:crypto'
import type { RpcContext } from '../core'

type Resource = { kind: string; workspace: string; identity: string; value: unknown }
type PageResources = {
  resources: Map<string, Resource>
  keys: Map<string, string>
  snapshots: Map<string, { epoch: string; version: number; retiredEpochs: Set<string> }>
}
const runtimes = new WeakMap<RpcContext['runtime'], Map<string, PageResources>>()

export function openMobileWebPageResources(context: RpcContext, pageSession: string): () => void {
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
    throw new Error('selector_not_found')
  }
  if (pages.size >= 128) {
    throw new Error('runtime_unavailable')
  }
  const page: PageResources = { resources: new Map(), keys: new Map(), snapshots: new Map() }
  pages.set(key, page)
  return () => {
    if (pages.get(key) === page) {
      pages.delete(key)
    }
  }
}

function pageResources(context: RpcContext, pageSession: string): PageResources {
  const page = runtimes
    .get(context.runtime)
    ?.get(JSON.stringify([context.connectionId, pageSession]))
  if (!page || !context.connectionId) {
    throw new Error('selector_not_found')
  }
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

export function retireMobileWebPageResources(
  context: RpcContext,
  pageSession: string,
  workspace: string,
  kind: string,
  identities: ReadonlySet<string>
): void {
  const page = pageResources(context, pageSession)
  for (const [handle, resource] of page.resources) {
    if (
      resource.workspace === workspace &&
      resource.kind === kind &&
      !identities.has(resource.identity)
    ) {
      page.resources.delete(handle)
      page.keys.delete(JSON.stringify([resource.kind, resource.workspace, resource.identity]))
    }
  }
}

export function admitMobileWebPageResourceSnapshot(
  context: RpcContext,
  pageSession: string,
  workspace: string,
  epoch: string,
  version: number
): void {
  const page = pageResources(context, pageSession)
  const previous = page.snapshots.get(workspace)
  if (
    previous &&
    ((previous.epoch === epoch && previous.version > version) || previous.retiredEpochs.has(epoch))
  ) {
    throw new Error('selector_not_found')
  }
  const retiredEpochs = previous?.retiredEpochs ?? new Set<string>()
  if (previous && previous.epoch !== epoch) {
    if (retiredEpochs.size >= 128) {
      throw new Error('runtime_unavailable')
    }
    retiredEpochs.add(previous.epoch)
  }
  if (!previous && page.snapshots.size >= 512) {
    throw new Error('runtime_unavailable')
  }
  page.snapshots.set(workspace, { epoch, version, retiredEpochs })
}
