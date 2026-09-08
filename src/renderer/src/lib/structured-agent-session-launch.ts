import {
  structuredAgentLabel,
  trackLaunchFailureToast
} from './structured-agent-session-launch-notification'
import { useSyncExternalStore } from 'react'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import {
  abandonStructuredAgentSessionLaunchIntent,
  createStructuredAgentSessionLaunchIntent,
  StructuredAgentSessionCreateRefusalError
} from '@/lib/launch-structured-agent-session'
import {
  discardStructuredAgentSessionLaunchOutbox,
  enqueueStructuredAgentSessionLaunchPrompt
} from '@/components/native-chat/structured-agent-session-launch-outbox'
import {
  launchAndReconcile,
  reconcileUnknownLaunch,
  type StructuredAgentLaunchReceipt,
  type StructuredLaunchRecoveryState
} from '@/lib/structured-agent-session-launch-recovery'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import {
  addStructuredLaunchCaller,
  claimStructuredLaunchCallerFallback,
  createStructuredLaunchCallerGroup,
  releaseStructuredLaunchCallerAfterUnknownOutcome,
  settleStructuredLaunchCallersWithFallback,
  settleStructuredLaunchCallersWithoutFallback,
  structuredLaunchCallersHavePendingWork,
  type StructuredAgentLaunchOptions,
  type StructuredLaunchCaller,
  type StructuredLaunchCallerGroup,
  type StructuredRefusalFallback
} from '@/lib/structured-agent-session-launch-callers'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import {
  hasStructuredLaunchCancellation,
  persistStructuredLaunchCancellation,
  retryStructuredLaunchCancellation,
  trackStructuredLaunchCancellationTargets,
  subscribeStructuredLaunchCancellation
} from './structured-agent-session-launch-cancellation'

export type { StructuredAgentLaunchOptions, StructuredAgentLaunchReceipt }

type StructuredLaunchState = StructuredLaunchRecoveryState & {
  identity: string
  callers: StructuredLaunchCallerGroup
  cancellationTargets: ReturnType<typeof trackStructuredLaunchCancellationTargets>
}

type StructuredLaunchStateResult = {
  state: StructuredLaunchState
  caller: StructuredLaunchCaller
}

export type StructuredAgentLaunchResult = {
  sessionId: string
  launchResult: Promise<StructuredAgentLaunchReceipt>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  isVisibilityUnknown: () => boolean
  releaseCallerAfterUnknownOutcome: () => boolean
  claimDefinitiveRefusalFallback: (fallback: StructuredRefusalFallback) => Promise<boolean>
}

export type StructuredAgentLaunchStatus = 'idle' | 'pending' | 'unknown'

const pendingStructuredLaunchesByIdentity = new Map<string, StructuredLaunchState>()
const structuredLaunchListeners = new Set<() => void>()

function notifyStructuredLaunchListeners(): void {
  for (const listener of structuredLaunchListeners) {
    listener()
  }
}

export function subscribeStructuredAgentLaunchStatus(listener: () => void): () => void {
  structuredLaunchListeners.add(listener)
  const detachCancellation = subscribeStructuredLaunchCancellation(listener)
  return () => {
    structuredLaunchListeners.delete(listener)
    detachCancellation()
  }
}

export function getStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  // Any launch for this pair, not just the blank one: adopting launches carry the conversation in
  // their identity, and a caller asking "is a chat starting here" means all of them.
  const states = [
    pendingStructuredLaunchesByIdentity.get(launchIdentity(worktreeId, agent)),
    ...[...pendingStructuredLaunchesByIdentity.entries()]
      .filter(([identity]) => identity.startsWith(`${agent}:${worktreeId}:resume:`))
      .map(([, state]) => state)
  ].filter((state): state is StructuredLaunchState => Boolean(state))
  if (hasStructuredLaunchCancellation(worktreeId, agent)) {
    return 'pending'
  }
  if (states.length === 0) {
    return 'idle'
  }
  return states.some((state) => state.visibilityUnknown) ? 'unknown' : 'pending'
}

export function useStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentLaunchStatus(worktreeId, agent),
    () => 'idle'
  )
}

function launchIdentity(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  resumeFrom?: StructuredAgentSessionResumeSource
): string {
  return resumeFrom
    ? `${agent}:${worktreeId}:resume:${resumeFrom.providerSessionId}`
    : `${agent}:${worktreeId}`
}

function cleanupLaunchState(state: StructuredLaunchState): void {
  if (pendingStructuredLaunchesByIdentity.get(state.identity) === state) {
    state.cancellationTargets.detach()
    pendingStructuredLaunchesByIdentity.delete(state.identity)
    notifyStructuredLaunchListeners()
  }
}

function maybeCleanupLaunchState(state: StructuredLaunchState): void {
  if (structuredLaunchCallersHavePendingWork(state.callers)) {
    return
  }
  cleanupLaunchState(state)
}

function settleDefinitiveRefusalFallback(state: StructuredLaunchState): void {
  if (state.callers.outcome === 'refused') {
    return
  }
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  discardStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  settleStructuredLaunchCallersWithFallback(state.callers)
}

function trackLaunchSettlement(
  state: StructuredLaunchState,
  promise: Promise<StructuredAgentLaunchReceipt>
): void {
  void promise.then(
    () => {
      if (state.promise !== promise || state.cancelled) {
        return
      }
      settleStructuredLaunchCallersWithoutFallback(state.callers, 'published')
      maybeCleanupLaunchState(state)
    },
    (error) => {
      if (state.promise !== promise || state.cancelled) {
        return
      }
      if (error instanceof StructuredAgentSessionCreateRefusalError) {
        settleDefinitiveRefusalFallback(state)
      } else if (!state.visibilityUnknown) {
        settleStructuredLaunchCallersWithoutFallback(state.callers, 'failed')
        maybeCleanupLaunchState(state)
      } else {
        state.callers.outcome = 'unknown'
        notifyStructuredLaunchListeners()
      }
    }
  )
}

function structuredAgentLaunchState(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions
): StructuredLaunchStateResult {
  const identity = launchIdentity(worktreeId, agent, options.resumeFrom)
  const existing = pendingStructuredLaunchesByIdentity.get(identity)
  if (existing) {
    if (existing.visibilityUnknown) {
      existing.callers.outcome = 'pending'
      existing.promise = reconcileUnknownLaunch(existing)
      trackLaunchSettlement(existing, existing.promise)
      trackLaunchFailureToast(existing)
      notifyStructuredLaunchListeners()
    }
    const text = options.prompt?.trim() ?? ''
    const stagedPrompt =
      text && existing.callers.outcome !== 'refused'
        ? enqueueStructuredAgentSessionLaunchPrompt(existing.intent.sessionId, text)
        : null
    return {
      state: existing,
      caller: addStructuredLaunchCaller({
        group: existing.callers,
        launchResult: existing.promise,
        options,
        stagedEntry: stagedPrompt
      })
    }
  }

  const intent = options.resumeFrom
    ? createStructuredAgentSessionLaunchIntent(worktreeId, agent, options.resumeFrom)
    : createStructuredAgentSessionLaunchIntent(worktreeId, agent)
  const cancellationTargets = trackStructuredLaunchCancellationTargets(intent.sessionId)
  const text = options.prompt?.trim() ?? ''
  const stagedPrompt = text
    ? enqueueStructuredAgentSessionLaunchPrompt(intent.sessionId, text)
    : null
  const callers = createStructuredLaunchCallerGroup()
  const state: StructuredLaunchState = {
    identity,
    intent,
    promise: Promise.resolve({ sessionId: '', fence: 0 }),
    visibilityUnknown: false,
    cancelled: false,
    onVisibilityChanged: notifyStructuredLaunchListeners,
    callers,
    cancellationTargets
  }
  callers.onSettled = () => maybeCleanupLaunchState(state)
  state.promise =
    text && !stagedPrompt
      ? Promise.reject(
          new StructuredAgentSessionCreateRefusalError(
            `Could not durably stage the ${structuredAgentLabel(agent)} launch prompt.`
          )
        )
      : launchAndReconcile(state)
  const caller = addStructuredLaunchCaller({
    group: state.callers,
    launchResult: state.promise,
    options,
    stagedEntry: stagedPrompt
  })
  pendingStructuredLaunchesByIdentity.set(identity, state)
  notifyStructuredLaunchListeners()
  trackLaunchSettlement(state, state.promise)
  trackLaunchFailureToast(state)
  return {
    state,
    caller
  }
}

export function cancelStructuredAgentLaunch(worktreeId: string, sessionId: string): boolean {
  const retry = retryStructuredLaunchCancellation(worktreeId, sessionId)
  if (retry !== undefined) {
    return retry
  }
  const state = [...pendingStructuredLaunchesByIdentity.values()].find(
    (candidate) =>
      candidate.intent.worktreeId === worktreeId && candidate.intent.sessionId === sessionId
  )
  if (!state) {
    return false
  }
  // Stop create reconciliation now; durable discard has its own retry owner.
  state.cancelled = true
  const targets = state.cancellationTargets.snapshot()
  cleanupLaunchState(state)
  const persisted = persistStructuredLaunchCancellation(state.intent, targets)
  settleStructuredLaunchCallersWithoutFallback(state.callers, 'cancelled')
  cleanupLaunchState(state)
  notifyStructuredLaunchListeners()
  return persisted
}

export function startStructuredAgentLaunch(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions = {}
): StructuredAgentLaunchResult {
  const { state, caller } = structuredAgentLaunchState(worktreeId, agent, options)
  return {
    sessionId: state.intent.sessionId,
    launchResult: state.promise,
    ...(caller.promptDeliveryResult ? { promptDeliveryResult: caller.promptDeliveryResult } : {}),
    isVisibilityUnknown: () => state.visibilityUnknown,
    releaseCallerAfterUnknownOutcome: () =>
      releaseStructuredLaunchCallerAfterUnknownOutcome(state.callers, caller),
    claimDefinitiveRefusalFallback: (fallback) =>
      claimStructuredLaunchCallerFallback(state.callers, caller, fallback)
  }
}
