import {
  MobileWebHostCatalogPayloadSchema,
  type MobileWebHostGrant
} from '../../../../shared/mobile-web/host-rpc-contract'
import { defineMethod } from '../core'

// Only page-safe results belong here; transport credentials never enter this catalog.
const PAGE_METHODS = new Map<string, MobileWebHostGrant>(
  [
    'git.status',
    'git.diff',
    'files.readDir',
    'files.readChunk',
    'mobileWeb.files.searchPaths',
    'mobileWeb.files.read',
    'mobileWeb.nativeChat.bind',
    'mobileWeb.nativeChat.read'
  ].map((method) => [
    method,
    {
      method,
      workspaceParam: 'worktree',
      ...(method.startsWith('mobileWeb.nativeChat.') ? { pageSessionParam: 'pageSession' } : {}),
      maxRequestBytes: 16 * 1024,
      maxResponseBytes: 512 * 1024
    }
  ])
)

const fileWatchGrant: MobileWebHostGrant = {
  method: 'mobileWeb.files.watch',
  workspaceParam: 'worktree',
  mode: 'subscription',
  unsubscribeMethod: 'files.unwatch',
  maxRequestBytes: 16 * 1024,
  maxResponseBytes: 512 * 1024
}
PAGE_METHODS.set(fileWatchGrant.method, fileWatchGrant)

PAGE_METHODS.set('mobileWeb.nativeChat.subscribe', {
  ...fileWatchGrant,
  method: 'mobileWeb.nativeChat.subscribe',
  pageSessionParam: 'pageSession',
  unsubscribeMethod: 'nativeChat.unsubscribe'
})

export const MOBILE_WEB_HOST_CATALOG_METHOD = defineMethod({
  name: 'mobileWeb.host.catalog',
  params: MobileWebHostCatalogPayloadSchema,
  handler: ({ methods }) => ({
    grants: [...new Set(methods)].flatMap((method) => {
      const grant = PAGE_METHODS.get(method)
      return grant ? [grant] : []
    })
  })
})

export function isMobileWebHostRpcMethod(method: string): boolean {
  return (
    PAGE_METHODS.has(method) ||
    [...PAGE_METHODS.values()].some((grant) => grant.unsubscribeMethod === method)
  )
}
