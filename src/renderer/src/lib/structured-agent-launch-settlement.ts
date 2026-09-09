import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import {
  startStructuredAgentLaunch,
  type StructuredAgentLaunchOptions
} from '@/lib/structured-agent-session-launch'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import type { ActivateAndRevealResult } from '@/lib/worktree-activation'

export type StructuredAgentLegacyFallbackResult = {
  /** Absent when the fallback opened a tab in an already-active workspace instead of activating one. */
  activation?: ActivateAndRevealResult | false
  primaryTabId: string | null
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
}

export type StructuredAgentLaunchSettlement =
  | {
      kind: 'structured'
      sessionId: string
      promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
    }
  | ({ kind: 'refused-then-legacy' } & StructuredAgentLegacyFallbackResult)
  | { kind: 'cancelled' }
  | { kind: 'visibility-unknown'; sessionId: string }
  | { kind: 'failed'; error: unknown }

export type StructuredAgentLaunchHooks = {
  /** What this flow did before structured chat existed: activate with a startup payload, set the
   *  first-message rename flag, run trust preflight. Runs at most once, only on definitive refusal.
   *  Resume has no legacy equivalent, so a refusal without this hook settles as `failed`. */
  legacyFallback?: () => Promise<StructuredAgentLegacyFallbackResult>
  onStructuredReady?: (sessionId: string) => void
  isCancelled?: () => boolean
}

/**
 * The one start / claim-refusal-fallback / await / branch loop every structured entrypoint shares.
 * Callers decide the route before calling and consume the settlement; they never touch the launch
 * handle themselves.
 */
export async function settleStructuredAgentLaunch(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions,
  hooks: StructuredAgentLaunchHooks
): Promise<StructuredAgentLaunchSettlement> {
  const isCancelled = (): boolean => hooks.isCancelled?.() === true
  const launch = startStructuredAgentLaunch(worktreeId, agent, options)
  // Why: a holder, not a `let`: TS narrows a closure-assigned local to its initial null.
  const fallback: { result: StructuredAgentLegacyFallbackResult | null } = { result: null }
  // Why: the claim resolves after the callback settles, so awaiting it below is what serialises
  // "refused" and "the legacy surface is up". The callback returns nothing so that wait ends at
  // activation, not at the end of a legacy paste that may be minutes away.
  const refusalFallback = launch.claimDefinitiveRefusalFallback(async () => {
    if (!hooks.legacyFallback || isCancelled()) {
      return
    }
    fallback.result = await hooks.legacyFallback()
  })
  try {
    const receipt = await launch.launchResult
    if (isCancelled()) {
      return { kind: 'cancelled' }
    }
    hooks.onStructuredReady?.(receipt.sessionId)
    return {
      kind: 'structured',
      sessionId: receipt.sessionId,
      ...(launch.promptDeliveryResult ? { promptDeliveryResult: launch.promptDeliveryResult } : {})
    }
  } catch (error) {
    if (isCancelled()) {
      return { kind: 'cancelled' }
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      const ran = await refusalFallback.then(
        (value) => value,
        (fallbackError: unknown) => ({ fallbackError })
      )
      if (isCancelled()) {
        return { kind: 'cancelled' }
      }
      if (typeof ran !== 'boolean') {
        return { kind: 'failed', error: ran.fallbackError }
      }
      return ran && fallback.result
        ? { kind: 'refused-then-legacy', ...fallback.result }
        : { kind: 'failed', error }
    }
    if (launch.isVisibilityUnknown()) {
      // Why: nobody awaits this caller once it returns, so a stale fallback closure must not fire
      // if a later retry on the same identity reconciles into a refusal. The launch state itself
      // stays pending so the badge shows "unknown" and the next click still reconciles.
      launch.releaseCallerAfterUnknownOutcome()
      return { kind: 'visibility-unknown', sessionId: launch.sessionId }
    }
    return { kind: 'failed', error }
  }
}
