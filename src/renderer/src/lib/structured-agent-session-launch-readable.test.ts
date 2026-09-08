// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  abandonIntent: vi.fn(),
  callStructuredAgentSession: vi.fn(),
  createIntent: vi.fn(),
  launch: vi.fn(),
  rendererTabs: {} as Record<string, unknown[]>,
  listeners: new Set<(state: { unifiedTabsByWorktree: Record<string, unknown[]> }) => void>()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    abandonStructuredAgentSessionLaunchIntent: mocks.abandonIntent,
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ unifiedTabsByWorktree: mocks.rendererTabs }),
    subscribe: (
      listener: (state: { unifiedTabsByWorktree: Record<string, unknown[]> }) => void
    ) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: { value0?: string }) =>
    fallback.replace('{{value0}}', options?.value0 ?? '')
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' }
  ]
}))

import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import {
  cancelStructuredAgentLaunch,
  getStructuredAgentLaunchStatus,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import { readOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'

function launchIntent(
  worktreeId: string,
  sessionId = `session-${worktreeId}`
): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    sessionId,
    agent: 'codex',
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: `fingerprint-${sessionId}`
      },
      worktree: `id:${worktreeId}`,
      agent: 'codex'
    }
  }
}

async function flushLaunchSettlement(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

describe('startStructuredAgentLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.rendererTabs = {}
    mocks.listeners.clear()
    mocks.createIntent.mockImplementation((worktreeId: string, agent: 'claude' | 'codex') => {
      const intent = launchIntent(worktreeId, `${agent}-session-${worktreeId}`)
      return { ...intent, agent, params: { ...intent.params, agent } }
    })
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      page: { fence: 1 }
    })
  })

  it.each(['pending-create', 'published'] as const)(
    'retains initial read-failed cancellation targets after %s without absorbing later operations',
    async (phase) => {
      const worktreeId = `wt-initial-read-${phase}`
      const intent = launchIntent(worktreeId)
      mocks.createIntent.mockReturnValueOnce(intent)
      let finishCreate!: (receipt: { sessionId: string; fence: number }) => void
      mocks.launch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCreate = resolve
          })
      )
      mocks.callStructuredAgentSession.mockResolvedValue({
        ok: true,
        value: { submission: { dispatchState: 'unknown' } }
      })
      const launch = startStructuredAgentLaunch(worktreeId, 'codex', {
        prompt: 'cancel original'
      })
      if (phase === 'published') {
        mocks.rendererTabs[worktreeId] = [
          {
            contentType: 'agent-session',
            entityId: intent.sessionId,
            worktreeId
          }
        ]
        finishCreate({ sessionId: intent.sessionId, fence: 1 })
        await launch.launchResult
        await flushLaunchSettlement()
      }
      const original = readOutbox(intent.sessionId, false)[0]
      const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
        throw new Error('synthetic read failure')
      })
      expect(cancelStructuredAgentLaunch(worktreeId, intent.sessionId)).toBe(false)
      expect(getStructuredAgentLaunchStatus(worktreeId, 'codex')).toBe('pending')
      expect(mocks.abandonIntent).not.toHaveBeenCalled()
      read.mockRestore()
      const { enqueueStructuredAgentSessionLaunchPrompt } =
        await import('@/components/native-chat/structured-agent-session-launch-outbox')
      const later = enqueueStructuredAgentSessionLaunchPrompt(intent.sessionId, 'later')!
      await flushLaunchSettlement()
      expect(readOutbox(intent.sessionId).map((entry) => entry.clientMessageId)).toEqual([
        later.clientMessageId
      ])
      expect(
        readOutbox(intent.sessionId).some(
          (entry) => entry.clientMessageId === original.clientMessageId
        )
      ).toBe(false)
      expect(mocks.abandonIntent).toHaveBeenCalledOnce()
      expect(getStructuredAgentLaunchStatus(worktreeId, 'codex')).toBe('idle')
      if (phase === 'pending-create') {
        finishCreate({ sessionId: intent.sessionId, fence: 1 })
        await expect(launch.launchResult).rejects.toThrow('cancelled')
      }
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({
        delivered: false
      })
    }
  )
})
