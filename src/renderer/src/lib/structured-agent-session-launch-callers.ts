import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import {
  settleStructuredAgentLaunchPrompt,
  type StructuredPromptDeliveryResult
} from '@/lib/structured-agent-session-launch-prompt'
import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'

export type StructuredRefusalFallback = () =>
  | void
  | StructuredPromptDeliveryResult
  | Promise<void | StructuredPromptDeliveryResult>

export type StructuredAgentLaunchOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready'
  onPromptDelivered?: () => void
  /** Adopt an existing provider conversation instead of starting a fresh one. Part of the launch's
   *  identity, not a preference — see `launchIdentity`. */
  resumeFrom?: StructuredAgentSessionResumeSource
}

export type StructuredLaunchCaller = {
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  refusalFallback: {
    callback: StructuredRefusalFallback | null
    promise: Promise<boolean>
    resolve: (ran: boolean) => void
    reject: (error: unknown) => void
    promptDeliveryPromise: Promise<StructuredPromptDeliveryResult | null>
    resolvePromptDelivery: (result: StructuredPromptDeliveryResult | null) => void
    started: boolean
    settled: boolean
    ran: boolean
  }
}

export type StructuredLaunchCallerGroup = {
  outcome: 'pending' | 'published' | 'failed' | 'refused' | 'unknown' | 'cancelled'
  entries: Set<StructuredLaunchCaller>
  promptDeliveryResults: Set<Promise<StructuredPromptDeliveryResult>>
  refusalSettlement: {
    promise: Promise<boolean>
    resolve: (ran: boolean) => void
    reject: (error: unknown) => void
    settled: boolean
    ran: boolean
    failure: { error: unknown } | null
  }
  onSettled: () => void
}

export function createStructuredLaunchCallerGroup(): StructuredLaunchCallerGroup {
  const refusalSettlement = Promise.withResolvers<boolean>()
  return {
    outcome: 'pending',
    entries: new Set(),
    promptDeliveryResults: new Set(),
    refusalSettlement: {
      promise: refusalSettlement.promise,
      resolve: refusalSettlement.resolve,
      reject: refusalSettlement.reject,
      settled: false,
      ran: false,
      failure: null
    },
    onSettled: () => {}
  }
}

function retireSettledCaller(
  group: StructuredLaunchCallerGroup,
  caller: StructuredLaunchCaller
): void {
  if (
    caller.refusalFallback.settled &&
    (!caller.promptDeliveryResult || !group.promptDeliveryResults.has(caller.promptDeliveryResult))
  ) {
    group.entries.delete(caller)
  }
}

function settleCallerWithoutFallback(
  group: StructuredLaunchCallerGroup,
  caller: StructuredLaunchCaller
): void {
  if (caller.refusalFallback.settled) {
    return
  }
  caller.refusalFallback.settled = true
  caller.refusalFallback.callback = null
  caller.refusalFallback.resolve(false)
  caller.refusalFallback.resolvePromptDelivery(null)
  retireSettledCaller(group, caller)
}

function finalizeRefusalSettlement(group: StructuredLaunchCallerGroup): void {
  if (
    group.outcome !== 'refused' ||
    group.refusalSettlement.settled ||
    [...group.entries].some((caller) => !caller.refusalFallback.settled)
  ) {
    return
  }
  group.refusalSettlement.settled = true
  if (group.refusalSettlement.failure) {
    group.refusalSettlement.reject(group.refusalSettlement.failure.error)
  } else {
    group.refusalSettlement.resolve(group.refusalSettlement.ran)
  }
  group.onSettled()
}

function runCallerRefusalFallback(
  group: StructuredLaunchCallerGroup,
  caller: StructuredLaunchCaller
): void {
  if (caller.refusalFallback.started || caller.refusalFallback.settled) {
    return
  }
  caller.refusalFallback.started = true
  const fallback = caller.refusalFallback.callback
  if (!fallback) {
    settleCallerWithoutFallback(group, caller)
    finalizeRefusalSettlement(group)
    return
  }
  void Promise.resolve()
    .then(fallback)
    .then(
      (result) => {
        caller.refusalFallback.ran = true
        group.refusalSettlement.ran = true
        caller.refusalFallback.resolve(true)
        caller.refusalFallback.resolvePromptDelivery(result ?? null)
      },
      (error) => {
        group.refusalSettlement.failure ??= { error }
        caller.refusalFallback.reject(error)
        caller.refusalFallback.resolvePromptDelivery(null)
      }
    )
    .finally(() => {
      caller.refusalFallback.settled = true
      caller.refusalFallback.callback = null
      retireSettledCaller(group, caller)
      finalizeRefusalSettlement(group)
    })
}

function trackPromptDelivery(
  group: StructuredLaunchCallerGroup,
  promptDeliveryResult: Promise<StructuredPromptDeliveryResult>,
  caller: StructuredLaunchCaller
): void {
  group.promptDeliveryResults.add(promptDeliveryResult)
  const settled = (): void => {
    group.promptDeliveryResults.delete(promptDeliveryResult)
    retireSettledCaller(group, caller)
    group.onSettled()
  }
  void promptDeliveryResult.then(settled, settled)
}

export function addStructuredLaunchCaller(args: {
  group: StructuredLaunchCallerGroup
  launchResult: Promise<{ sessionId: string; fence: number }>
  options: StructuredAgentLaunchOptions
  stagedEntry: StructuredAgentSessionOutboxEntry | null
}): StructuredLaunchCaller {
  const fallback = Promise.withResolvers<boolean>()
  const fallbackPromptDelivery = Promise.withResolvers<StructuredPromptDeliveryResult | null>()
  const caller: StructuredLaunchCaller = {
    refusalFallback: {
      callback: null,
      promise: fallback.promise,
      resolve: fallback.resolve,
      reject: fallback.reject,
      promptDeliveryPromise: fallbackPromptDelivery.promise,
      resolvePromptDelivery: fallbackPromptDelivery.resolve,
      started: false,
      settled: false,
      ran: false
    }
  }
  args.group.entries.add(caller)
  const promptDeliveryResult = settleStructuredAgentLaunchPrompt({
    launchResult: args.launchResult,
    options: args.options,
    stagedEntry: args.stagedEntry
  })
  caller.promptDeliveryResult = promptDeliveryResult?.catch(async (error) => {
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      return (
        (await caller.refusalFallback.promptDeliveryPromise) ?? {
          delivered: false,
          failureNotified: true
        }
      )
    }
    return { delivered: false, failureNotified: true }
  })
  if (caller.promptDeliveryResult) {
    trackPromptDelivery(args.group, caller.promptDeliveryResult, caller)
  }
  if (['published', 'failed', 'cancelled'].includes(args.group.outcome)) {
    settleCallerWithoutFallback(args.group, caller)
  } else if (args.group.outcome === 'refused') {
    queueMicrotask(() => runCallerRefusalFallback(args.group, caller))
  }
  return caller
}

export function settleStructuredLaunchCallersWithoutFallback(
  group: StructuredLaunchCallerGroup,
  outcome: 'published' | 'failed' | 'cancelled'
): void {
  group.outcome = outcome
  for (const caller of group.entries) {
    settleCallerWithoutFallback(group, caller)
  }
  if (!group.refusalSettlement.settled) {
    group.refusalSettlement.settled = true
    group.refusalSettlement.resolve(false)
  }
  group.onSettled()
}

export function settleStructuredLaunchCallersWithFallback(
  group: StructuredLaunchCallerGroup
): void {
  if (group.outcome === 'refused') {
    return
  }
  group.outcome = 'refused'
  for (const caller of group.entries) {
    runCallerRefusalFallback(group, caller)
  }
  finalizeRefusalSettlement(group)
}

export function claimStructuredLaunchCallerFallback(
  group: StructuredLaunchCallerGroup,
  caller: StructuredLaunchCaller,
  fallback: StructuredRefusalFallback
): Promise<boolean> {
  if (!caller.refusalFallback.settled && !caller.refusalFallback.started) {
    caller.refusalFallback.callback ??= fallback
  }
  if (group.outcome === 'refused') {
    runCallerRefusalFallback(group, caller)
  }
  return caller.refusalFallback.promise
}

export function releaseStructuredLaunchCallerAfterUnknownOutcome(
  group: StructuredLaunchCallerGroup,
  caller: StructuredLaunchCaller
): boolean {
  if (group.outcome !== 'unknown' || !group.entries.delete(caller)) {
    return false
  }
  settleCallerWithoutFallback(group, caller)
  group.onSettled()
  return true
}

export function structuredLaunchCallersHavePendingWork(
  group: StructuredLaunchCallerGroup
): boolean {
  return (
    group.outcome === 'pending' ||
    group.outcome === 'unknown' ||
    group.promptDeliveryResults.size > 0 ||
    (group.outcome === 'refused' && !group.refusalSettlement.settled)
  )
}
