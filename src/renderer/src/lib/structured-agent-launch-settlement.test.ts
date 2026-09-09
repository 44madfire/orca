import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startStructuredAgentLaunch: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredAgentLaunch: mocks.startStructuredAgentLaunch
}))

vi.mock('@/lib/launch-structured-agent-session', () => ({
  StructuredAgentSessionCreateRefusalError: class extends Error {}
}))

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { settleStructuredAgentLaunch } from './structured-agent-launch-settlement'

type FakeLaunch = {
  launchResult: Promise<unknown>
  visibilityUnknown?: boolean
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
}

/** Mirrors the callers layer: the claim runs the callback once the launch is refused and resolves
 *  with whether it ran; a non-refusal settlement resolves it false without running it. */
function fakeLaunch(args: FakeLaunch) {
  const releaseCallerAfterUnknownOutcome = vi.fn(() => true)
  const claimDefinitiveRefusalFallback = vi.fn((fallback: () => Promise<void>) =>
    args.launchResult.then(
      () => false,
      (error) =>
        error instanceof StructuredAgentSessionCreateRefusalError
          ? Promise.resolve()
              .then(fallback)
              .then(() => true)
          : false
    )
  )
  mocks.startStructuredAgentLaunch.mockReturnValue({
    sessionId: 'session-1',
    launchResult: args.launchResult,
    ...(args.promptDeliveryResult ? { promptDeliveryResult: args.promptDeliveryResult } : {}),
    isVisibilityUnknown: () => args.visibilityUnknown === true,
    releaseCallerAfterUnknownOutcome,
    claimDefinitiveRefusalFallback
  })
  return { releaseCallerAfterUnknownOutcome, claimDefinitiveRefusalFallback }
}

const fallbackResult = {
  activation: { primaryTabId: 'fallback-tab' },
  primaryTabId: 'fallback-tab'
}

describe('settleStructuredAgentLaunch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns structured and activates once the launch is published', async () => {
    const promptDeliveryResult = Promise.resolve({ delivered: true, failureNotified: false })
    fakeLaunch({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      promptDeliveryResult
    })
    const onStructuredReady = vi.fn()
    const legacyFallback = vi.fn()

    await expect(
      settleStructuredAgentLaunch(
        'worktree-1',
        'codex',
        { prompt: 'Fix' },
        {
          legacyFallback,
          onStructuredReady
        }
      )
    ).resolves.toEqual({ kind: 'structured', sessionId: 'session-1', promptDeliveryResult })
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledWith('worktree-1', 'codex', {
      prompt: 'Fix'
    })
    expect(onStructuredReady).toHaveBeenCalledWith('session-1')
    expect(legacyFallback).not.toHaveBeenCalled()
  })

  it('runs the legacy fallback exactly once after a definitive refusal', async () => {
    fakeLaunch({
      launchResult: Promise.reject(new StructuredAgentSessionCreateRefusalError('unsupported'))
    })
    const legacyFallback = vi.fn().mockResolvedValue(fallbackResult)
    const onStructuredReady = vi.fn()

    await expect(
      settleStructuredAgentLaunch('worktree-1', 'codex', {}, { legacyFallback, onStructuredReady })
    ).resolves.toEqual({ kind: 'refused-then-legacy', ...fallbackResult })
    expect(legacyFallback).toHaveBeenCalledOnce()
    expect(onStructuredReady).not.toHaveBeenCalled()
  })

  it('carries a fallback that opened a tab without activating a workspace', async () => {
    fakeLaunch({
      launchResult: Promise.reject(new StructuredAgentSessionCreateRefusalError('unsupported'))
    })
    const promptDeliveryResult = Promise.resolve({ delivered: true, failureNotified: false })
    const legacyFallback = vi
      .fn()
      .mockResolvedValue({ primaryTabId: 'new-tab', promptDeliveryResult })

    await expect(
      settleStructuredAgentLaunch('worktree-1', 'codex', {}, { legacyFallback })
    ).resolves.toEqual({
      kind: 'refused-then-legacy',
      primaryTabId: 'new-tab',
      promptDeliveryResult
    })
  })

  it('fails a refusal that has no legacy equivalent', async () => {
    const error = new StructuredAgentSessionCreateRefusalError('unsupported')
    fakeLaunch({ launchResult: Promise.reject(error) })

    await expect(settleStructuredAgentLaunch('worktree-1', 'codex', {}, {})).resolves.toEqual({
      kind: 'failed',
      error
    })
  })

  it('fails when the legacy fallback itself throws', async () => {
    const fallbackError = new Error('no terminal')
    fakeLaunch({
      launchResult: Promise.reject(new StructuredAgentSessionCreateRefusalError('unsupported'))
    })
    const legacyFallback = vi.fn().mockRejectedValue(fallbackError)

    await expect(
      settleStructuredAgentLaunch('worktree-1', 'codex', {}, { legacyFallback })
    ).resolves.toEqual({ kind: 'failed', error: fallbackError })
  })

  it('reports an unknown outcome, releases the caller, and never runs the fallback', async () => {
    const { releaseCallerAfterUnknownOutcome } = fakeLaunch({
      launchResult: Promise.reject(new Error('connection lost')),
      visibilityUnknown: true
    })
    const legacyFallback = vi.fn()

    await expect(
      settleStructuredAgentLaunch('worktree-1', 'codex', {}, { legacyFallback })
    ).resolves.toEqual({ kind: 'visibility-unknown', sessionId: 'session-1' })
    expect(releaseCallerAfterUnknownOutcome).toHaveBeenCalledOnce()
    expect(legacyFallback).not.toHaveBeenCalled()
  })

  it('fails a non-refusal error whose outcome is known', async () => {
    const error = new Error('boom')
    const { releaseCallerAfterUnknownOutcome } = fakeLaunch({ launchResult: Promise.reject(error) })
    const legacyFallback = vi.fn()

    await expect(
      settleStructuredAgentLaunch('worktree-1', 'codex', {}, { legacyFallback })
    ).resolves.toEqual({ kind: 'failed', error })
    expect(releaseCallerAfterUnknownOutcome).not.toHaveBeenCalled()
    expect(legacyFallback).not.toHaveBeenCalled()
  })

  it('returns cancelled after a successful launch without activating', async () => {
    fakeLaunch({ launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }) })
    const onStructuredReady = vi.fn()

    await expect(
      settleStructuredAgentLaunch(
        'worktree-1',
        'codex',
        {},
        {
          onStructuredReady,
          isCancelled: () => true
        }
      )
    ).resolves.toEqual({ kind: 'cancelled' })
    expect(onStructuredReady).not.toHaveBeenCalled()
  })

  it('returns cancelled after a refusal without running the fallback', async () => {
    fakeLaunch({
      launchResult: Promise.reject(new StructuredAgentSessionCreateRefusalError('unsupported'))
    })
    const legacyFallback = vi.fn().mockResolvedValue(fallbackResult)

    await expect(
      settleStructuredAgentLaunch(
        'worktree-1',
        'codex',
        {},
        {
          legacyFallback,
          isCancelled: () => true
        }
      )
    ).resolves.toEqual({ kind: 'cancelled' })
    expect(legacyFallback).not.toHaveBeenCalled()
  })
})
