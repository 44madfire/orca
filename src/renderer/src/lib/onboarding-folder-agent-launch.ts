import { isAgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  OnboardingFolderAgentStartup,
  resolveDismissedOnboardingFolderAgentLaunch
} from '@/lib/onboarding-folder-agent-startup'
import { settleStructuredAgentLaunch } from '@/lib/structured-agent-launch-settlement'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'

/** Reveal a folder just added after dismissed onboarding and start its default agent on the
 *  resolved route. Both add-folder paths (local store action, SSH dialog) share this; the store
 *  path must import it lazily because the launch graph reaches the store root. */
export async function revealOnboardingFolderWithAgentLaunch(args: {
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
  launch: ReturnType<typeof resolveDismissedOnboardingFolderAgentLaunch>
}): Promise<void> {
  const reveal = (
    startup: OnboardingFolderAgentStartup | undefined,
    providesInitialSurface = false
  ) =>
    activateAndRevealWorktree(args.worktreeId, {
      sidebarRevealBehavior: 'auto',
      ...(args.executionHostId ? { executionHostId: args.executionHostId } : {}),
      ...(startup ? { startup } : {}),
      ...(providesInitialSurface ? { providesInitialSurface: true } : {})
    })
  const structured = args.launch.route === 'structured-native-chat'
  reveal(args.launch.startup, structured)
  if (!structured || !isAgentSessionHandleProvider(args.launch.agent)) {
    return
  }
  // Why: the outcome is not consumed; the workspace is already revealed and the launch layer toasts.
  await settleStructuredAgentLaunch(
    args.worktreeId,
    args.launch.agent,
    {},
    {
      legacyFallback: async () => {
        const activation = reveal(args.launch.fallbackStartup)
        return { activation, primaryTabId: activation === false ? null : activation.primaryTabId }
      }
    }
  )
}
