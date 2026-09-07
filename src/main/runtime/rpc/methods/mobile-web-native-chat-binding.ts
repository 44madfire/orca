import { z } from 'zod'
import type { RpcContext } from '../core'
import { mobileWebNativeChatBinding } from './mobile-web-session-snapshot'
import {
  mobileWebSessionResources,
  type MobileWebHostNativeChatBinding
} from './mobile-web-session-resources'
import {
  admitMobileWebPageResourceSnapshot,
  resolveMobileWebPageResource
} from './mobile-web-page-resources'

export const MobileWebChatScope = z.object({
  worktree: z.string().min(1).max(4096),
  pageSession: z.string().min(1).max(160)
})
type Binding = {
  tabId: string
  agent: string
  sessionId: string
  transcriptPath?: string
  terminal: string
  worktreeId: string
}

async function readBinding(
  context: RpcContext,
  params: z.infer<typeof MobileWebChatScope>,
  tabId: string
): Promise<MobileWebHostNativeChatBinding> {
  const snapshot = await context.runtime.listMobileSessionTabs(
    params.worktree,
    context.pairedDeviceId
  )
  if (`id:${snapshot.worktree}` !== params.worktree) {
    throw new Error('selector_not_found')
  }
  admitMobileWebPageResourceSnapshot(
    context,
    params.pageSession,
    params.worktree,
    snapshot.publicationEpoch,
    snapshot.snapshotVersion
  )
  const bindings = snapshot.tabs.flatMap((tab) => {
    const binding = mobileWebNativeChatBinding(tab, snapshot.worktree)
    return binding ? [binding] : []
  })
  if (
    !('workspaceTransportState' in snapshot) ||
    snapshot.workspaceTransportState !== 'unavailable'
  ) {
    mobileWebSessionResources(context, params.pageSession).nativeChat.synchronizeWorkspace(
      snapshot.worktree,
      bindings
    )
  }
  const binding = bindings.find((entry) => entry.hostTabId === tabId)
  if (!binding?.hostTerminalId) {
    throw new Error('selector_not_found')
  }
  return binding
}

export async function bindMobileWebNativeChat(
  context: RpcContext,
  params: z.infer<typeof MobileWebChatScope> & { tabId: string }
) {
  const binding = await readBinding(context, params, params.tabId)
  return {
    resourceId: mobileWebSessionResources(context, params.pageSession).nativeChat.register(binding)
  }
}

export async function resolveMobileWebNativeChat(
  context: RpcContext,
  params: z.infer<typeof MobileWebChatScope> & { resourceId: string }
) {
  const binding = resolveMobileWebPageResource<MobileWebHostNativeChatBinding>(
    context,
    params.pageSession,
    params.worktree,
    'sessionChat',
    params.resourceId
  )
  const current = await readBinding(context, params, binding.hostTabId)
  if (JSON.stringify(current) !== JSON.stringify(binding)) {
    throw new Error('selector_not_found')
  }
  return {
    tabId: binding.hostTabId,
    agent: binding.agent,
    sessionId: binding.providerSessionId,
    transcriptPath: binding.transcriptPath,
    terminal: binding.hostTerminalId!,
    worktreeId: binding.hostWorkspaceId
  }
}

export function mobileWebNativeChatHostParams(binding: Binding, params: Record<string, unknown>) {
  return {
    ...params,
    agent: binding.agent,
    sessionId: binding.sessionId,
    transcriptPath: binding.transcriptPath,
    terminal: binding.terminal,
    worktreeId: binding.worktreeId
  }
}
