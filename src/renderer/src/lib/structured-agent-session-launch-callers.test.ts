// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import {
  addStructuredLaunchCaller,
  claimStructuredLaunchCallerFallback,
  createStructuredLaunchCallerGroup,
  settleStructuredLaunchCallersWithFallback,
  settleStructuredLaunchCallersWithoutFallback
} from './structured-agent-session-launch-callers'

function join(group: ReturnType<typeof createStructuredLaunchCallerGroup>) {
  return addStructuredLaunchCaller({
    group,
    launchResult: Promise.resolve({ sessionId: 'caller-retirement', fence: 1 }),
    options: {},
    stagedEntry: null
  })
}

it('retires promptless callers and refuses to retain late unusable fallbacks', async () => {
  const group = createStructuredLaunchCallerGroup()
  const caller = join(group)
  settleStructuredLaunchCallersWithoutFallback(group, 'published')
  const fallback = vi.fn()
  expect(await claimStructuredLaunchCallerFallback(group, caller, fallback)).toBe(false)
  expect(group.entries.size).toBe(0)
  expect(caller.refusalFallback.callback).toBe(null)
  expect(fallback).not.toHaveBeenCalled()
})

it('keeps unresolved fallbacks and preserves successful receipts after membership retirement', async () => {
  const group = createStructuredLaunchCallerGroup()
  const first = join(group)
  const second = join(group)
  const pending = Promise.withResolvers<void>()
  const ran = claimStructuredLaunchCallerFallback(group, first, () => pending.promise)
  const absent = second.refusalFallback.promise
  settleStructuredLaunchCallersWithFallback(group)
  expect(group.entries.size).toBe(1)
  expect(group.entries.has(first)).toBe(true)
  expect(group.refusalSettlement.settled).toBe(false)
  pending.resolve()
  expect(await ran).toBe(true)
  expect(await absent).toBe(false)
  expect(await group.refusalSettlement.promise).toBe(true)
  expect(group.entries.size).toBe(0)
  expect(first.refusalFallback.callback).toBe(null)
  expect(await first.refusalFallback.promise).toBe(true)
})

it('retires failed fallbacks without losing the failure receipt', async () => {
  const group = createStructuredLaunchCallerGroup()
  const caller = join(group)
  const failure = new Error('synthetic fallback failed')
  const result = claimStructuredLaunchCallerFallback(group, caller, () => {
    throw failure
  })
  const callerFailure = expect(result).rejects.toBe(failure)
  const groupFailure = expect(group.refusalSettlement.promise).rejects.toBe(failure)
  settleStructuredLaunchCallersWithFallback(group)
  await Promise.all([callerFailure, groupFailure])
  expect(group.entries.size).toBe(0)
  expect(caller.refusalFallback.callback).toBe(null)
})
