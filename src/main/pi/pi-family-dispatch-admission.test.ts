// Pi-family admitted-dispatch settlement against a fake backend (PIF-4, #25).
//
// Adapter-level proof without a provider child: prompt acknowledgement arms
// ephemeral correlation, terminal frames and OMP `prompt_result` settle it
// from staged history with stable provider identity, and superseded
// generations cannot mutate replacement state. Scripted-child settlement
// lives in `pi-family-dispatch-settlement.test.ts`.

import { describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import {
  PiStructuredSessionAdapter,
  type PiStructuredBackend
} from './pi-structured-session-adapter'

function freshIdentity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'pi',
    providerHandle: { kind: 'opaque', agent: 'pi', value: 'pending' }
  }
}

function textBody(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

describe('PiStructuredSessionAdapter history-backed settlement (PIF-4)', () => {
  function userEntry(id: string, parentId: string | null, text: string) {
    return {
      type: 'message',
      id,
      parentId,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text }] }
    }
  }

  function markerEntry() {
    return {
      type: 'message',
      id: 'leaf-0',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] }
    }
  }

  type Settlement = {
    sessionId: string
    clientMessageId: string
    providerIdentity: { provider: string; agent: string; sessionId: string; recordId: string }
  }

  async function waitForSettlements(settlements: Settlement[], count: number): Promise<void> {
    const start = Date.now()
    for (;;) {
      if (settlements.length >= count) {
        return
      }
      if (Date.now() - start > 5_000) {
        throw new Error(`timed out waiting for ${count} late settlements`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  function harness(staged: { entries: unknown[]; leafId: string }[]) {
    const settlements: Settlement[] = []
    const recordHandlers: ((record: Record<string, unknown>) => void)[] = []
    let reads = 0
    const backend: PiStructuredBackend = {
      dispatch: async () => ({ status: 'accepted' as const }),
      cancel: async () => ({ cancelled: false }),
      close: async () => true,
      acquire: async (input: Parameters<PiStructuredBackend['acquire']>[0]) => {
        if (input.onRecord) {
          recordHandlers.push(input.onRecord)
        }
        return {
          piSessionId: 'pi-ses-1',
          leafId: 'leaf-1',
          pid: 4242,
          sessionFilePath: '/tmp/pi-ses-1.jsonl'
        }
      },
      readEntries: async () =>
        staged[Math.min(reads++, staged.length - 1)] ?? { entries: [], leafId: 'leaf-0' }
    }
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend,
      readProcessStartTime: async () => 12345,
      onDispatchSettledLate: (settlement) => {
        const identity = settlement.providerIdentity
        if (identity.provider === 'legacy') {
          settlements.push({
            sessionId: settlement.sessionId,
            clientMessageId: settlement.clientMessageId,
            providerIdentity: {
              provider: identity.provider,
              agent: identity.agent,
              sessionId: identity.sessionId,
              recordId: identity.recordId
            }
          })
        }
      }
    })
    return { adapter, settlements, recordHandlers }
  }

  it('settles an admitted dispatch from history with stable provider identity', async () => {
    const pre = userEntry('e-pre', null, 'first')
    const fresh = userEntry('e-new', 'e-pre', 'second')
    const { adapter, settlements, recordHandlers } = harness([
      { entries: [pre], leafId: 'e-pre' },
      { entries: [pre, fresh], leafId: 'e-new' }
    ])
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    await expect(
      adapter.dispatch({
        sessionId: 'ses-1',
        clientMessageId: 'c1',
        body: textBody('second'),
        fence: 0
      })
    ).resolves.toEqual({ state: 'admitted' })
    recordHandlers[0]?.({ type: 'agent_settled' })
    await waitForSettlements(settlements, 1)
    // The entry id proves delivery; the client message id never becomes provider identity.
    expect(settlements).toEqual([
      {
        sessionId: 'ses-1',
        clientMessageId: 'c1',
        providerIdentity: {
          provider: 'legacy',
          agent: 'pi',
          sessionId: 'pi-ses-1',
          recordId: 'e-new'
        }
      }
    ])
  })

  it('settles once across duplicate terminal observations', async () => {
    const marker = markerEntry()
    const fresh = userEntry('e-new', 'leaf-0', 'second')
    const before = { entries: [marker], leafId: 'leaf-0' }
    const { adapter, settlements, recordHandlers } = harness([
      before,
      { entries: [marker, fresh], leafId: 'e-new' }
    ])
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    await adapter.dispatch({
      sessionId: 'ses-1',
      clientMessageId: 'c1',
      body: textBody('second'),
      fence: 0
    })
    recordHandlers[0]?.({ type: 'agent_settled' })
    recordHandlers[0]?.({ type: 'agent_settled' })
    await waitForSettlements(settlements, 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(settlements).toHaveLength(1)
  })

  it('retires an OMP local-only prompt without awaiting an agent turn', async () => {
    const marker = markerEntry()
    const fresh = userEntry('e-new', 'leaf-0', 'second')
    const before = { entries: [marker], leafId: 'leaf-0' }
    const { adapter, settlements, recordHandlers } = harness([
      before,
      { entries: [marker, fresh], leafId: 'e-new' }
    ])
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    await adapter.dispatch({
      sessionId: 'ses-1',
      clientMessageId: 'c1',
      body: textBody('second'),
      fence: 0
    })
    // No terminal frame is ever delivered; the local-only result settles from history alone.
    recordHandlers[0]?.({ type: 'prompt_result', id: 'r1', agentInvoked: false })
    await waitForSettlements(settlements, 1)
    expect(settlements[0]).toMatchObject({ clientMessageId: 'c1' })
    expect(settlements[0]?.providerIdentity.recordId).toBe('e-new')
  })

  it('holds an OMP agent-turn prompt_result for the terminal boundary', async () => {
    const marker = markerEntry()
    const fresh = userEntry('e-new', 'leaf-0', 'second')
    const before = { entries: [marker], leafId: 'leaf-0' }
    const { adapter, settlements, recordHandlers } = harness([
      before,
      { entries: [marker, fresh], leafId: 'e-new' }
    ])
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    await adapter.dispatch({
      sessionId: 'ses-1',
      clientMessageId: 'c1',
      body: textBody('second'),
      fence: 0
    })
    recordHandlers[0]?.({ type: 'prompt_result', id: 'r1', agentInvoked: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(settlements).toHaveLength(0)
    recordHandlers[0]?.({ type: 'agent_settled' })
    await waitForSettlements(settlements, 1)
  })

  it('a stale acquisition generation cannot settle replacement dispatch state', async () => {
    const marker = markerEntry()
    const fresh = userEntry('e-new', 'leaf-0', 'second')
    const before = { entries: [marker], leafId: 'leaf-0' }
    const { adapter, settlements, recordHandlers } = harness([
      before,
      before,
      { entries: [marker, fresh], leafId: 'e-new' }
    ])
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    await adapter.dispatch({
      sessionId: 'ses-1',
      clientMessageId: 'c-old',
      body: textBody('first'),
      fence: 0
    })
    // Replacement acquisition retires the old correlation; its terminal echo settles nothing.
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-2' })
    recordHandlers[0]?.({ type: 'agent_settled' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(settlements).toHaveLength(0)
    await adapter.dispatch({
      sessionId: 'ses-1',
      clientMessageId: 'c-new',
      body: textBody('second'),
      fence: 0
    })
    recordHandlers[1]?.({ type: 'agent_settled' })
    await waitForSettlements(settlements, 1)
    expect(settlements).toEqual([
      expect.objectContaining({
        clientMessageId: 'c-new',
        providerIdentity: expect.objectContaining({ recordId: 'e-new' })
      })
    ])
  })
})
