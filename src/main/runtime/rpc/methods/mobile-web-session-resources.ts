import type { RpcContext } from '../core'
import {
  registerMobileWebPageResource,
  retireMobileWebPageResources
} from './mobile-web-page-resources'

export type MobileWebHostNativeChatBinding = {
  hostWorkspaceId: string
  hostTabId: string
  hostTerminalId: string | null
  agent: string
  providerSessionId: string
  transcriptPath?: string
}

export type MobileWebSessionBrowserResources = {
  synchronizeWorkspace: (workspace: string, ids: readonly string[]) => void
  register: (workspace: string, id: string) => string
}
export type MobileWebSessionChatResources = {
  synchronizeWorkspace: (
    workspace: string,
    bindings: readonly MobileWebHostNativeChatBinding[]
  ) => void
  register: (binding: MobileWebHostNativeChatBinding) => string
}

export function mobileWebSessionResources(context: RpcContext, pageSession: string) {
  const browser: MobileWebSessionBrowserResources = {
    synchronizeWorkspace: (workspace, ids) =>
      retireMobileWebPageResources(
        context,
        pageSession,
        `id:${workspace}`,
        'browser',
        new Set(ids)
      ),
    register: (workspace, id) =>
      registerMobileWebPageResource(context, pageSession, {
        kind: 'browser',
        workspace: `id:${workspace}`,
        identity: id,
        value: { hostWorkspaceId: workspace, hostPageId: id }
      })
  }
  const nativeChat: MobileWebSessionChatResources = {
    synchronizeWorkspace: (workspace, bindings) =>
      retireMobileWebPageResources(
        context,
        pageSession,
        `id:${workspace}`,
        'sessionChat',
        new Set(bindings.map((binding) => JSON.stringify(binding)))
      ),
    register: (binding) =>
      registerMobileWebPageResource(context, pageSession, {
        kind: 'sessionChat',
        workspace: `id:${binding.hostWorkspaceId}`,
        identity: JSON.stringify(binding),
        value: binding
      })
  }
  return { browser, nativeChat }
}
