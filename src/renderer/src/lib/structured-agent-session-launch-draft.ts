import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { useAppStore } from '@/store'
import type { StructuredAgentLaunchOptions } from './structured-agent-session-launch-callers'

export function seedStructuredAgentLaunchDraft(
  sessionId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions
): void {
  if (options.promptDelivery === 'draft' && options.prompt) {
    seedNativeChatLaunchDraftForAgentTab({
      tabId: structuredAgentSessionTabId(sessionId),
      agent,
      text: options.prompt
    })
  }
}

export function clearStructuredAgentLaunchDraft(sessionId: string): void {
  useAppStore.getState().clearNativeChatLaunchDraft(structuredAgentSessionTabId(sessionId))
}
