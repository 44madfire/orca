import { useMemo, useState } from 'react'
import { structuredForkEligibleItems } from '../../../../shared/agent-session-prefix'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import { forkStructuredSessionFromTurn } from './structured-agent-session-fork-command'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

export function useStructuredForkAction(
  props: Omit<NativeChatStructuredViewProps, 'mode'>,
  controller: ReturnType<typeof useStructuredAgentSession>,
  worktreeId: string | undefined,
  onError: (message: string) => void
) {
  const [pending, setPending] = useState(false)
  const eligibleIds = useMemo(
    () => structuredForkEligibleItems(controller.journalItems ?? []),
    [controller.journalItems]
  )
  const agent = props.agent === 'claude' ? 'claude' : props.agent === 'codex' ? 'codex' : undefined
  if (
    !controller.forkSupported ||
    !controller.forkSource ||
    !worktreeId ||
    controller.isWorking ||
    !agent
  ) {
    return undefined
  }
  return {
    eligibleIds,
    pending,
    onFork: (itemId: string) => {
      if (!controller.forkSource) {
        return
      }
      setPending(true)
      void forkStructuredSessionFromTurn({
        target: props.target,
        worktree: toRuntimeWorktreeSelector(worktreeId),
        agent,
        source: { ...controller.forkSource, itemId }
      })
        .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
        .finally(() => setPending(false))
    }
  }
}
