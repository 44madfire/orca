import { useAppStore } from '@/store'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { activateAndRevealWorktree, type ActivateAndRevealResult } from '@/lib/worktree-activation'
import type { StructuredAgentLegacyFallbackResult } from '@/lib/structured-agent-launch-settlement'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { activateStructuredAgentSessionById } from '@/lib/structured-agent-session-tab-activation'
import { preflightAgentTrust } from '@/lib/agent-trust-preflight'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { closeStructuredAgentSession } from '@/runtime/structured-agent-session-close'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

export type WorktreeCreationStructuredSessionResult = {
  accepted: boolean
  cancelled: boolean
  visibilityUnknown: boolean
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
}

type LaunchStructuredWorktreeSessionArgs = {
  creationId: string
  request: WorktreeCreationRequest
  worktreeId: string
  shouldActivateOnCompletion: boolean
  fallbackStartupOpt: WorktreeStartupPayload | undefined
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
  recoverUnknownLaunch?: boolean
}

async function retireCancelledStructuredSession(
  worktreeId: string,
  sessionId: string
): Promise<void> {
  const target = { kind: 'local' } as const
  await closeStructuredAgentSession(target, sessionId).catch(() => undefined)
  await callRuntimeRpc(target, 'session.tabs.close', {
    worktree: toRuntimeWorktreeSelector(worktreeId),
    tabId: `agent-session:${sessionId}`,
    reason: 'user'
  }).catch(() => undefined)
}

/** What quick create did before structured chat: rename flag, trust preflight, then a terminal. */
async function openLegacyWorktreeSurface(
  args: LaunchStructuredWorktreeSessionArgs,
  isCancelled: () => boolean
): Promise<StructuredAgentLegacyFallbackResult> {
  const unchanged = { activation: args.activation, primaryTabId: args.primaryTabId }
  if (args.request.pendingFirstAgentMessageRename) {
    await useAppStore
      .getState()
      .updateWorktreeMeta(args.worktreeId, { pendingFirstAgentMessageRename: true })
      .catch(() => undefined)
  }
  if (isCancelled()) {
    return unchanged
  }
  const worktree = useAppStore
    .getState()
    .allWorktrees?.()
    .find((candidate) => candidate.id === args.worktreeId)
  if (args.request.agent && worktree?.path) {
    const repoConnectionId = useAppStore
      .getState()
      .repos.find((repo) => repo.id === args.request.repoId)?.connectionId
    await preflightAgentTrust({
      agent: args.request.agent,
      workspacePath: worktree.path,
      connectionId: repoConnectionId
    })
  }
  if (isCancelled()) {
    return unchanged
  }
  if (args.shouldActivateOnCompletion) {
    const activation = activateAndRevealWorktree(args.worktreeId, {
      sidebarRevealBehavior: 'auto',
      createNewTerminalForStartup: true,
      ...(args.fallbackStartupOpt ? { startup: args.fallbackStartupOpt } : {})
    })
    return { activation, primaryTabId: activation === false ? null : activation.primaryTabId }
  }
  return {
    primaryTabId: ensureWorktreeHasInitialTerminal(
      useAppStore.getState(),
      args.worktreeId,
      args.fallbackStartupOpt,
      undefined,
      undefined,
      undefined,
      { activateCreatedTabs: false, createNewTerminalForStartup: true }
    )
  }
}

export async function launchStructuredWorktreeSession(
  args: LaunchStructuredWorktreeSessionArgs
): Promise<WorktreeCreationStructuredSessionResult> {
  const { activation, primaryTabId } = args
  const settled = { accepted: true, cancelled: false, visibilityUnknown: false }
  const { agent, agentLaunchRoute } = args.request
  if (!agent) {
    return { ...settled, activation, primaryTabId }
  }
  const isCancelled = (): boolean =>
    !useAppStore.getState().pendingWorktreeCreations[args.creationId]
  if (isCancelled()) {
    return { ...settled, cancelled: true, activation, primaryTabId }
  }
  let refused = false
  // Why: the composer decided route and delivery mode before the worktree existed; re-entering
  // with that persisted verdict is what keeps recovery from re-resolving on a changed host.
  const plan = adoptAgentSessionLaunchVerdict({
    route: agentLaunchRoute ?? 'terminal-tui',
    agent,
    ...(args.recoverUnknownLaunch
      ? {}
      : {
          prompt: args.request.launchDraftPrompt ?? args.request.quickPrompt,
          ...(args.request.promptDelivery ? { promptDelivery: args.request.promptDelivery } : {})
        })
  })
  const settlement = await plan.launch(
    {
      cancellation: {
        isCancelled,
        subscribe: (onCancel) =>
          useAppStore.subscribe((state) => {
            if (!state.pendingWorktreeCreations[args.creationId]) {
              onCancel()
            }
          })
      },
      legacyFallback: () => {
        refused = true
        return openLegacyWorktreeSurface(args, isCancelled)
      },
      onStructuredReady: (sessionId) => {
        if (args.shouldActivateOnCompletion) {
          activateStructuredAgentSessionById({ worktreeId: args.worktreeId, sessionId })
        }
      }
    },
    { worktreeId: args.worktreeId }
  )
  if (!settlement) {
    return { ...settled, activation, primaryTabId }
  }
  switch (settlement.kind) {
    case 'cancelled':
      // Why: a refusal means no session exists on the host, so there is nothing to retire.
      if (!refused) {
        await retireCancelledStructuredSession(args.worktreeId, settlement.sessionId)
      }
      return { ...settled, accepted: !refused, cancelled: true, activation, primaryTabId }
    case 'refused-then-legacy':
      return {
        ...settled,
        accepted: false,
        activation: settlement.activation ?? activation,
        primaryTabId: settlement.primaryTabId
      }
    case 'visibility-unknown':
      return { ...settled, visibilityUnknown: true, activation, primaryTabId }
    case 'structured':
    case 'failed':
      // Why: a failed launch has always reported as accepted here; the launch layer toasts it.
      return { ...settled, activation, primaryTabId }
  }
}
