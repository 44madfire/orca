import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  settleStructuredAgentLaunch,
  type StructuredAgentLaunchSettlement
} from '@/lib/structured-agent-launch-settlement'
import { activateStructuredAgentSessionById } from '@/lib/structured-agent-session-tab-activation'

/** Full-create dialog: the structured launch plus what this flow did before structured chat
 *  existed. Returns null when the route is not structured. */
export async function settleFullCreationStructuredLaunch(args: {
  structuredLaunch: boolean
  agent: TuiAgent
  worktreeId: string
  prompt: string
  promptDelivery: 'draft' | 'auto-submit'
  startup: WorktreeStartupPayload | undefined
  pendingFirstAgentMessageRename: boolean
  applyWorktreeMeta: (
    worktreeId: string,
    meta: { pendingFirstAgentMessageRename: boolean }
  ) => Promise<void>
}): Promise<StructuredAgentLaunchSettlement | null> {
  if (!args.structuredLaunch || !isAgentSessionHandleProvider(args.agent)) {
    return null
  }
  return settleStructuredAgentLaunch(
    args.worktreeId,
    args.agent,
    { prompt: args.prompt, promptDelivery: args.promptDelivery },
    {
      legacyFallback: async () => {
        if (args.pendingFirstAgentMessageRename) {
          await args
            .applyWorktreeMeta(args.worktreeId, { pendingFirstAgentMessageRename: true })
            .catch(() => undefined)
        }
        const activation = activateAndRevealWorktree(args.worktreeId, {
          sidebarRevealBehavior: 'auto',
          createNewTerminalForStartup: true,
          ...(args.startup ? { startup: args.startup } : {})
        })
        return { activation, primaryTabId: activation === false ? null : activation.primaryTabId }
      },
      onStructuredReady: (sessionId) =>
        activateStructuredAgentSessionById({ worktreeId: args.worktreeId, sessionId })
    }
  )
}
