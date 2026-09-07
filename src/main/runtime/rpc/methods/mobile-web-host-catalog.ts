import { MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES } from '../../../../shared/mobile-web/bridge-limits'
import {
  MobileWebHostCatalogPayloadSchema,
  type MobileWebHostGrant
} from '../../../../shared/mobile-web/host-rpc-contract'
import { defineMethod } from '../core'

// Reads whose result is a directory, a file, a diff or a transcript page, so the only honest
// ceiling is the bridge envelope the shell can actually deliver.
const READ_HEAVY_METHODS = new Set([
  'mobileWeb.files.readDir',
  'mobileWeb.files.read',
  'mobileWeb.sourceControl.diff',
  'mobileWeb.session.snapshot',
  'mobileWeb.nativeChat.read'
])

// Only page-safe results belong here; transport credentials never enter this catalog.
const PAGE_METHODS = new Map<string, MobileWebHostGrant>(
  [
    'mobileWeb.sourceControl.status',
    'mobileWeb.sourceControl.diff',
    'mobileWeb.files.readDir',
    'files.readChunk',
    'mobileWeb.files.searchPaths',
    'mobileWeb.files.read',
    'mobileWeb.terminal.action',
    'mobileWeb.nativeChat.read',
    'mobileWeb.nativeChat.mutate',
    'mobileWeb.nativeChat.fileSearch',
    'mobileWeb.nativeChat.openFile',
    'mobileWeb.nativeChat.readability',
    'mobileWeb.session.snapshot',
    'mobileWeb.session.activate',
    'mobileWeb.session.close',
    'mobileWeb.session.createBrowser',
    'mobileWeb.session.quickCommands',
    'mobileWeb.session.quickCommandMutate',
    'mobileWeb.session.createQuickCommand',
    'mobileWeb.session.agentOptions',
    'mobileWeb.session.createTerminal'
  ].map((method) => [
    method,
    {
      method,
      workspaceParam: 'worktree',
      maxRequestBytes:
        method === 'mobileWeb.nativeChat.mutate'
          ? MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES
          : 16 * 1024,
      maxResponseBytes: READ_HEAVY_METHODS.has(method)
        ? MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES
        : 512 * 1024
    }
  ])
)

for (const method of [
  'terminal.getAutoRestoreFit',
  'terminal.setAutoRestoreFit',
  'mobileWeb.session.capabilities'
]) {
  PAGE_METHODS.set(method, {
    method,
    scope: 'host',
    maxRequestBytes: 1024,
    maxResponseBytes: method === 'mobileWeb.session.capabilities' ? 64 * 1024 : 1024
  })
}

for (const method of [
  'speech.models.list',
  'speech.models.download',
  'speech.models.delete',
  'speech.dictation.setup'
]) {
  PAGE_METHODS.set(method, {
    method,
    scope: 'host',
    maxRequestBytes: 4096,
    maxResponseBytes: 64 * 1024
  })
}

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
  unsubscribeMethod: 'nativeChat.unsubscribe'
})

PAGE_METHODS.set('mobileWeb.session.subscribe', {
  ...fileWatchGrant,
  method: 'mobileWeb.session.subscribe',
  unsubscribeMethod: 'mobileWeb.session.unsubscribe'
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
