import { z } from 'zod'
import type { RpcContext } from '../core'
import {
  registerMobileWebPageResource,
  resolveMobileWebPageResource
} from './mobile-web-page-resources'

export const MobileWebChatScope = z.object({
  worktree: z.string().min(1).max(4096),
  pageSession: z.string().min(1).max(160)
})
const ProviderSession = z.object({ id: z.string().min(1), transcriptPath: z.string().optional() })
const TerminalTab = z.object({
  id: z.string(),
  type: z.literal('terminal'),
  terminal: z.string().min(1),
  launchAgent: z.string().optional(),
  agentStatus: z.object({ agentType: z.string().optional(), providerSession: ProviderSession })
})
type Binding = {
  tabId: string
  agent: string
  sessionId: string
  transcriptPath?: string
  terminal: string
  worktreeId: string
}

async function readBinding(context: RpcContext, worktree: string, tabId: string): Promise<Binding> {
  const snapshot = await context.runtime.listMobileSessionTabs(worktree, context.pairedDeviceId)
  const parsed = TerminalTab.safeParse(snapshot.tabs.find((tab) => tab.id === tabId))
  if (!parsed.success) {
    throw new Error('selector_not_found')
  }
  const tab = parsed.data
  const agent = tab.agentStatus.agentType ?? tab.launchAgent
  if (!agent) {
    throw new Error('selector_not_found')
  }
  return {
    tabId,
    agent,
    sessionId: tab.agentStatus.providerSession.id,
    ...(tab.agentStatus.providerSession.transcriptPath
      ? { transcriptPath: tab.agentStatus.providerSession.transcriptPath }
      : {}),
    terminal: tab.terminal,
    worktreeId: snapshot.worktree
  }
}

export async function bindMobileWebNativeChat(
  context: RpcContext,
  params: z.infer<typeof MobileWebChatScope> & { tabId: string }
) {
  const binding = await readBinding(context, params.worktree, params.tabId)
  return {
    resourceId: registerMobileWebPageResource(context, params.pageSession, {
      kind: 'nativeChat',
      workspace: params.worktree,
      identity: JSON.stringify(binding),
      value: binding
    })
  }
}

export async function resolveMobileWebNativeChat(
  context: RpcContext,
  params: z.infer<typeof MobileWebChatScope> & { resourceId: string }
) {
  const binding = resolveMobileWebPageResource<Binding>(
    context,
    params.pageSession,
    params.worktree,
    'nativeChat',
    params.resourceId
  )
  const current = await readBinding(context, params.worktree, binding.tabId)
  if (JSON.stringify(current) !== JSON.stringify(binding)) {
    throw new Error('selector_not_found')
  }
  return binding
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
