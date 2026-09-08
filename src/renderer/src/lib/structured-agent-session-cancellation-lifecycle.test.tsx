// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useStructuredAgentSessionOutbox } from '@/components/native-chat/use-structured-agent-session-outbox'

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
} from '@/lib/structured-agent-session-launch'
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('launch cancellation authority', () => {
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

  it.each(['read', 'write'] as const)(
    'retains cancellation authority after pre-request %s failure',
    async (fault) => {
      const worktreeId = `wt-pre-request-${fault}`
      const intent = launchIntent(worktreeId)
      mocks.createIntent.mockReturnValueOnce(intent)
      mocks.launch.mockResolvedValueOnce({ sessionId: intent.sessionId, fence: 1 })
      mocks.rendererTabs[worktreeId] = [
        { contentType: 'agent-session', entityId: intent.sessionId, worktreeId }
      ]
      mocks.callStructuredAgentSession.mockResolvedValue({
        ok: true,
        value: { submission: { dispatchState: 'unknown' } }
      })
      const launch = startStructuredAgentLaunch(worktreeId, 'codex', {
        prompt: 'retained before request'
      })
      await launch.launchResult
      await flushLaunchSettlement()
      expect(getStructuredAgentLaunchStatus(worktreeId, 'codex')).toBe('pending')
      const read = vi
        .spyOn(localStorage, fault === 'read' ? 'getItem' : 'removeItem')
        .mockImplementation(() => {
          throw new Error('synthetic pre-request read failure')
        })
      let statusBeforeClose: string
      let closeWhileUnreadable: boolean
      try {
        renderHook(() =>
          useStructuredAgentSessionOutbox({
            sessionId: intent.sessionId,
            target: { kind: 'local' },
            fence: null,
            submissions:
              fault === 'read'
                ? []
                : [
                    {
                      clientMessageId: readOutbox(intent.sessionId)[0].clientMessageId,
                      dispatchState: 'accepted'
                    } as never
                  ]
          })
        )
        await act(async () => {
          await flushLaunchSettlement()
        })
        await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: false })
        statusBeforeClose = getStructuredAgentLaunchStatus(worktreeId, 'codex')
        closeWhileUnreadable = cancelStructuredAgentLaunch(worktreeId, intent.sessionId)
      } finally {
        cleanup()
        read.mockRestore()
      }
      const closeAfterRestoration = cancelStructuredAgentLaunch(worktreeId, intent.sessionId)
      const evidence = {
        statusBeforeClose,
        closeWhileUnreadable,
        closeAfterRestoration,
        retained: readOutbox(intent.sessionId).length,
        abandonCalls: mocks.abandonIntent.mock.calls.length
      }
      expect(evidence.statusBeforeClose).toBe('idle')
      expect(evidence.closeWhileUnreadable).toBe(false)
      expect(evidence.closeAfterRestoration).toBe(true)
      expect(evidence.retained).toBe(0)
      expect(evidence.abandonCalls).toBe(1)
    }
  )
})
