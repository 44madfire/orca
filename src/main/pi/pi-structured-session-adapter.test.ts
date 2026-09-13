import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import {
  PiStructuredSessionAdapter,
  type PiStructuredBackend
} from './pi-structured-session-adapter'

const LOCAL: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'folder'
}

function identity(sessionId: string, agent = 'pi'): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: agent as 'pi',
    providerHandle: { kind: 'opaque', agent: 'pi', value: 'pi:pi-ses-1' }
  } as unknown as AgentSessionJournalIdentity
}

function textBody(text: string) {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] } as never
}

function fakeBackend(overrides?: Partial<PiStructuredBackend>): PiStructuredBackend & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    acquire: async ({ workspaceRoot, spawnToken }: { workspaceRoot: string; spawnToken: string }) => {
      calls.push(`acquire:${workspaceRoot}:${spawnToken}`)
      return { piSessionId: 'pi-ses-1', leafId: 'leaf-1', pid: 4242, sessionFilePath: '/tmp/pi-ses-1.jsonl' }
    },
    dispatch: async () => ({ status: 'accepted', piSessionId: 'pi-ses-1' }),
    cancel: async () => ({ cancelled: true }),
    close: async () => true,
    ...overrides
  } as unknown as PiStructuredBackend & { calls: string[] }
}

describe('PiStructuredSessionAdapter capability gates', () => {
  it('claims only pi on proven local locations', () => {
    const adapter = new PiStructuredSessionAdapter({ resolveWorkspacePath: () => '/tmp/ws' })
    expect(adapter.supportsCreate?.(LOCAL, 'pi')).toBe(true)
    expect(adapter.supportsCreate?.(LOCAL, 'codex')).toBe(false)
    expect(adapter.supportsCreate?.(LOCAL, 'claude')).toBe(false)
    expect(
      adapter.supportsCreate?.({ ...LOCAL, wslDistro: 'Ubuntu' }, 'pi')
    ).toBe(false)
    expect(
      adapter.supportsCreate?.({ ...LOCAL, executionHostId: 'ssh:host-1' }, 'pi')
    ).toBe(false)
  })

  it('fails closed without a backend rather than fabricating a session', async () => {
    const adapter = new PiStructuredSessionAdapter({ resolveWorkspacePath: () => '/tmp/ws' })
    await expect(
      adapter.acquire({ identity: identity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    ).rejects.toThrow('PI_STRUCTURED_UNAVAILABLE')
  })

  it('refuses a non-pi agent rather than mis-attributing ownership', async () => {
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend: fakeBackend()
    })
    await expect(
      adapter.acquire({ identity: identity('ses-1', 'codex'), fence: 0, spawnToken: 'spawn-1' })
    ).rejects.toThrow('does not own agent')
  })

  it('requires a non-empty workspaceRoot', async () => {
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '   ',
      backend: fakeBackend(),
      readProcessStartTime: async () => 123
    })
    await expect(
      adapter.acquire({ identity: identity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    ).rejects.toThrow('BAD_WORKSPACE')
  })
})

describe('PiStructuredSessionAdapter lifecycle proof', () => {
  it('mints the exact Pi session/leaf link with a pid-reuse-safe process identity', async () => {
    const backend = fakeBackend()
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend,
      readProcessStartTime: async (pid) => (pid === 4242 ? 12345 : null)
    })
    const acquired = await adapter.acquire({ identity: identity('ses-1'), fence: 7, spawnToken: 'spawn-1' })
    expect(acquired.link.handle).toEqual({ provider: 'pi', sessionId: 'pi-ses-1', leafId: 'leaf-1' })
    expect(acquired.link.mintedAtFence).toBe(7)
    expect(acquired.process).toMatchObject({ pid: 4242, processStartTimeMs: 12345, spawnToken: 'spawn-1' })
    expect(typeof acquired.acquisitionGeneration).toBe('string')
  })

  it('reaps the child and fails closed when start-time proof is unreadable', async () => {
    const close = vi.fn(async () => true)
    const backend = fakeBackend({ close })
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend,
      readProcessStartTime: async () => null
    })
    await expect(
      adapter.acquire({ identity: identity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    ).rejects.toThrow('start time')
    expect(close).toHaveBeenCalledWith({ piSessionId: 'pi-ses-1' })
  })

  it('returns true only after the backend proves child exit; unproven close retains the owner', async () => {
    const backend = fakeBackend({ close: async () => false })
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend,
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({ identity: identity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    await expect(adapter.closeSession('ses-1')).resolves.toBe(false)
    // Retained owner still dispatches; a fabricated clean exit would have dropped it.
    await expect(
      adapter.dispatch({ sessionId: 'ses-1', clientMessageId: 'c1', body: textBody('hi'), fence: 0 })
    ).resolves.toMatchObject({ state: 'accepted' })
  })

  it('proves closeAll across every live child and reports the shutdown when unprovable', async () => {
    const backend = fakeBackend({ close: async () => false })
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend,
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({ identity: identity('ses-a'), fence: 0, spawnToken: 's-a' })
    await adapter.acquire({ identity: identity('ses-b'), fence: 0, spawnToken: 's-b' })
    await expect(adapter.closeAll()).rejects.toThrow('could not prove every child stopped')
  })

  it('maps a backend close failure to exit-unproven rather than a clean exit', async () => {
    const backend = fakeBackend({
      close: async () => {
        throw new Error('kill failed')
      }
    })
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend,
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({ identity: identity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    await expect(adapter.closeSession('ses-1')).rejects.toMatchObject({
      name: 'AgentSessionAcquisitionExitUnprovenError'
    })
  })
})

describe('PiStructuredSessionAdapter dispatch honesty', () => {
  it('rejects stale fences and never auto-resends unknown dispatches', async () => {
    const backend = fakeBackend({
      dispatch: async () => {
        throw new Error('transport lost')
      }
    })
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend,
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({ identity: identity('ses-1'), fence: 5, spawnToken: 'spawn-1' })
    await expect(
      adapter.dispatch({ sessionId: 'ses-1', clientMessageId: 'c1', body: textBody('hi'), fence: 4 })
    ).resolves.toMatchObject({ state: 'rejected' })
    const unknown = await adapter.dispatch({
      sessionId: 'ses-1',
      clientMessageId: 'c2',
      body: textBody('hi'),
      fence: 5
    })
    expect(unknown).toMatchObject({ state: 'unknown' })
  })

  it('rejects image blocks and empty prompts without touching the provider', async () => {
    const dispatch = vi.fn(
      async (): Promise<{ status: 'accepted'; piSessionId: string }> => ({
        status: 'accepted',
        piSessionId: 'pi-ses-1'
      })
    )
    const backend = fakeBackend({ dispatch })
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend,
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({ identity: identity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    await expect(
      adapter.dispatch({
        sessionId: 'ses-1',
        clientMessageId: 'c1',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'image-ref' }] } as never,
        fence: 0
      })
    ).resolves.toMatchObject({ state: 'rejected' })
    await expect(
      adapter.dispatch({ sessionId: 'ses-1', clientMessageId: 'c2', body: textBody('   '), fence: 0 })
    ).resolves.toMatchObject({ state: 'rejected' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('fence-checks cancel and reports the Pi session file for handoff identity', async () => {
    const backend = fakeBackend()
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend,
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({ identity: identity('ses-1'), fence: 5, spawnToken: 'spawn-1' })
    await expect(adapter.cancelTurn({ sessionId: 'ses-1', turnId: 't1', fence: 4 })).resolves.toEqual({
      cancelled: false
    })
    await expect(
      adapter.historyFilePath?.({ identity: identity('ses-1') })
    ).resolves.toBe('/tmp/pi-ses-1.jsonl')
    await expect(adapter.historyFilePath?.({ identity: identity('missing') })).resolves.toBe(null)
  })
})

describe('Pi router routing preserves Codex/Claude', () => {
  it('routes pi only to the pi adapter and leaves codex/claude untouched', async () => {
    const codex = {
      acquire: vi.fn(async () => ({ process: { pid: 1 } }) as never),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsLocation: () => true
    } as unknown as StructuredAgentSessionAdapter
    const claude = {
      acquire: vi.fn(async () => ({ process: { pid: 2 } }) as never),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsLocation: () => true
    } as unknown as StructuredAgentSessionAdapter
    const pi = new PiStructuredSessionAdapter({ resolveWorkspacePath: () => '/tmp/ws' })
    const router = new StructuredAgentSessionAdapterRouter({ codex, claude, pi }, async () => {})
    expect(router.supportsCreate?.(LOCAL, 'pi')).toBe(true)
    expect(router.supportsCreate?.(LOCAL, 'codex')).toBe(true)
    expect(router.supportsCreate?.(LOCAL, 'unknown-agent')).toBe(false)
    const withoutPi = new StructuredAgentSessionAdapterRouter({ codex, claude }, async () => {})
    expect(withoutPi.supportsCreate?.(LOCAL, 'pi')).toBe(false)
  })
})
