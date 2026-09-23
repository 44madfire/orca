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

function freshIdentity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'pi',
    providerHandle: { kind: 'opaque', agent: 'pi', value: 'pending' }
  } as unknown as AgentSessionJournalIdentity
}

function resumeIdentity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'pi',
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
    acquire: async (input: { orcaSessionId: string; workspaceRoot: string; spawnToken: string }) => {
      calls.push(`acquire:${input.workspaceRoot}:${input.spawnToken}`)
      return { piSessionId: 'pi-ses-1', leafId: 'leaf-1', pid: 4242, sessionFilePath: '/tmp/pi-ses-1.jsonl' }
    },
    dispatch: async () => ({ status: 'accepted' }),
    cancel: async () => ({ cancelled: true }),
    close: async () => true,
    sessionFilePath: async () => '/tmp/pi-ses-1.jsonl',
    answerPrompt: async () => undefined,
    setOption: async (input: { key: string; value: string }) => ({ [input.key]: input.value }),
    readOptions: async () => ({ options: { model: 'test/model' }, model: 'test/model', thinkingLevel: undefined }),
    listModels: async () => [],
    listThinkingLevels: async () => [],
    readResumeHistory: async () => ({ rows: [], leafId: 'leaf-1' }),
    ...overrides
  } as unknown as PiStructuredBackend & { calls: string[] }
}

function adapterWithFake(
  backend: PiStructuredBackend,
  events: { ended: unknown[] } = { ended: [] }
): PiStructuredSessionAdapter {
  return new PiStructuredSessionAdapter({
    resolveWorkspacePath: () => '/tmp/ws',
    backend,
    readProcessStartTime: async (pid) => (pid === 4242 ? 12345 : null),
    onEvent: (event) => {
      events.ended.push(event)
    }
  })
}

describe('PiStructuredSessionAdapter capability gates', () => {
  it('claims only the Pi family on proven local locations', () => {
    const adapter = new PiStructuredSessionAdapter({ resolveWorkspacePath: () => '/tmp/ws' })
    expect(adapter.supportsCreate?.(LOCAL, 'pi')).toBe(true)
    expect(adapter.supportsCreate?.(LOCAL, 'omp')).toBe(true)
    expect(adapter.supportsCreate?.(LOCAL, 'codex')).toBe(false)
    expect(adapter.supportsCreate?.(LOCAL, 'claude')).toBe(false)
    expect(adapter.supportsCreate?.(LOCAL, 'external')).toBe(false)
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
      adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    ).rejects.toThrow('PI_STRUCTURED_UNAVAILABLE')
  })

  it('refuses a non-pi agent rather than mis-attributing ownership', async () => {
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend: fakeBackend()
    })
    const identity = { ...freshIdentity('ses-1'), agent: 'codex' } as unknown as AgentSessionJournalIdentity
    await expect(
      adapter.acquire({ identity, fence: 0, spawnToken: 'spawn-1' })
    ).rejects.toThrow('does not own agent')
  })

  it('requires a non-empty workspaceRoot', async () => {
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '   ',
      backend: fakeBackend(),
      readProcessStartTime: async () => 123
    })
    await expect(
      adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    ).rejects.toThrow('BAD_WORKSPACE')
  })

  it('refuses a resume without the exact session file instead of minting a fresh session', async () => {
    const dispatch = vi.fn(async () => ({ status: 'accepted' as const }))
    const adapter = adapterWithFake(fakeBackend({ dispatch }))
    await expect(
      adapter.acquire({ identity: resumeIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    ).rejects.toThrow('PI_RESUME_FAILED')
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('PiStructuredSessionAdapter lifecycle proof', () => {
  it('mints the exact Pi session/leaf link with a pid-reuse-safe process identity', async () => {
    const backend = fakeBackend()
    const adapter = adapterWithFake(backend)
    const acquired = await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 7, spawnToken: 'spawn-1' })
    expect(acquired.link.handle).toEqual({
      provider: 'pi',
      sessionId: 'pi-ses-1',
      leafId: 'leaf-1',
      sessionFile: '/tmp/pi-ses-1.jsonl'
    })
    expect(acquired.link.mintedAtFence).toBe(7)
    expect(acquired.process).toMatchObject({ pid: 4242, processStartTimeMs: 12345, spawnToken: 'spawn-1' })
    expect(typeof acquired.acquisitionGeneration).toBe('string')
  })

  it('resumes the exact session when the host-owned file accompanies the resume identity', async () => {
    const acquire = vi.fn(async () => ({
      piSessionId: 'pi-ses-1',
      leafId: 'leaf-2',
      pid: 4242,
      sessionFilePath: '/tmp/pi-ses-1.jsonl'
    }))
    const adapter = adapterWithFake(fakeBackend({ acquire }))
    const acquired = await adapter.acquire({
      identity: resumeIdentity('ses-1'),
      fence: 4,
      spawnToken: 'spawn-2',
      resumeSessionFile: '/tmp/pi-ses-1.jsonl'
    })
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({ resumePiSessionId: 'pi-ses-1', resumeSessionFile: '/tmp/pi-ses-1.jsonl' })
    )
    expect(acquired.link.origin).toBe('resumed')
    expect(acquired.link.handle).toMatchObject({ sessionId: 'pi-ses-1', leafId: 'leaf-2' })
  })

  it('reaps the child and fails closed when start-time proof is unreadable', async () => {
    const close = vi.fn(async () => true)
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend: fakeBackend({ close }),
      readProcessStartTime: async () => null
    })
    await expect(
      adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    ).rejects.toThrow('start time')
    expect(close).toHaveBeenCalledWith({ orcaSessionId: 'ses-1' })
  })

  it('returns true only after the backend proves child exit; unproven close retains the owner', async () => {
    const backend = fakeBackend({ close: async () => false })
    const adapter = adapterWithFake(backend)
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    await expect(adapter.closeSession('ses-1')).resolves.toBe(false)
    await expect(
      adapter.dispatch({ sessionId: 'ses-1', clientMessageId: 'c1', body: textBody('hi'), fence: 0 })
    ).resolves.toMatchObject({ state: 'accepted' })
  })

  it('proves closeAll across every live child and reports the shutdown when unprovable', async () => {
    const backend = fakeBackend({ close: async () => false })
    const adapter = adapterWithFake(backend)
    await adapter.acquire({ identity: freshIdentity('ses-a'), fence: 0, spawnToken: 's-a' })
    await adapter.acquire({ identity: freshIdentity('ses-b'), fence: 0, spawnToken: 's-b' })
    await expect(adapter.closeAll()).rejects.toThrow('could not prove every child stopped')
  })

  it('maps a backend close failure to exit-unproven rather than a clean exit', async () => {
    const backend = fakeBackend({
      close: async () => {
        throw new Error('kill failed')
      }
    })
    const adapter = adapterWithFake(backend)
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    await expect(adapter.closeSession('ses-1')).rejects.toMatchObject({
      name: 'AgentSessionAcquisitionExitUnprovenError'
    })
  })

  it('publishes an unexpected-exit lifecycle event for host recovery', async () => {
    const events: { ended: unknown[] } = { ended: [] }
    const adapter = adapterWithFake(fakeBackend(), events)
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 3, spawnToken: 'spawn-1' })
    adapter.publishUnexpectedExit('ses-1')
    expect(events.ended).toHaveLength(1)
    expect(events.ended[0]).toMatchObject({
      type: 'ended',
      sessionId: 'ses-1',
      cause: 'unexpected-exit',
      fence: 3
    })
    adapter.publishUnexpectedExit('missing')
    expect(events.ended).toHaveLength(1)
  })
})

describe('PiStructuredSessionAdapter dispatch honesty', () => {
  it('rejects stale fences and never auto-resends unknown dispatches', async () => {
    const backend = fakeBackend({
      dispatch: async () => {
        throw new Error('transport lost')
      }
    })
    const adapter = adapterWithFake(backend)
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 5, spawnToken: 'spawn-1' })
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

  it('forwards the full body so the backend validates text and images', async () => {
    const dispatch = vi.fn(async () => ({ status: 'accepted' as const }))
    const adapter = adapterWithFake(fakeBackend({ dispatch }))
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    const body = textBody('hello')
    await adapter.dispatch({ sessionId: 'ses-1', clientMessageId: 'c1', body, fence: 0 })
    expect(dispatch).toHaveBeenCalledWith({ orcaSessionId: 'ses-1', body })
  })

  it('fence-checks cancel and reports the Pi session file for handoff identity', async () => {
    const adapter = adapterWithFake(fakeBackend())
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 5, spawnToken: 'spawn-1' })
    await expect(adapter.cancelTurn({ sessionId: 'ses-1', turnId: 't1', fence: 4 })).resolves.toEqual({
      cancelled: false
    })
    await expect(
      adapter.historyFilePath?.({ identity: freshIdentity('ses-1') })
    ).resolves.toBe('/tmp/pi-ses-1.jsonl')
    await expect(adapter.historyFilePath?.({ identity: freshIdentity('missing') })).resolves.toBe(null)
  })

  it('routes prompt answers by journal item key and tracks restore failures', async () => {
    const answerPrompt = vi.fn(async () => undefined)
    const adapter = adapterWithFake(fakeBackend({ answerPrompt }))
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    await adapter.answerPrompt({ sessionId: 'ses-1', itemId: 'item-key-1', kind: 'approval', optionId: 'confirm', fence: 0 })
    expect(answerPrompt).toHaveBeenCalledWith({ itemKey: 'item-key-1', kind: 'approval', optionId: 'confirm' })
    await expect(
      adapter.setOption({ sessionId: 'ses-1', key: 'bogus', value: 'x', fence: 0 })
    ).rejects.toThrow('no session option named')
    expect(adapter.readOptionRestoreFailures?.('ses-1')).toContain('bogus')
  })

  it('reads resume history only for the live fence', async () => {
    const readResumeHistory = vi.fn(async (): Promise<{ rows: []; leafId: string }> => ({ rows: [], leafId: 'leaf-1' }))
    const adapter = adapterWithFake(fakeBackend({ readResumeHistory }))
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 5, spawnToken: 'spawn-1' })
    await expect(adapter.readResumeHistory?.({ sessionId: 'ses-1', fence: 4 })).rejects.toThrow(
      'agent_session_checkpoint_stale'
    )
    await expect(adapter.readResumeHistory?.({ sessionId: 'ses-1', fence: 5 })).resolves.toEqual({
      rows: [],
      leafId: 'leaf-1'
    })
  })

  it('reports the live model catalog instead of an empty temp', async () => {
    const adapter = adapterWithFake(
      fakeBackend({
        readOptions: async () => ({ options: { model: 'test/model' }, model: 'test/model', thinkingLevel: 'high' }),
        listModels: async () => [{ id: 'model', provider: 'test' }],
        listThinkingLevels: async () => ['low', 'high']
      })
    )
    await adapter.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    const options = await adapter.readOptions({ sessionId: 'ses-1', fence: 0 })
    expect(options.current).toMatchObject({ model: 'test/model', effort: 'high' })
    expect(options.models).toHaveLength(1)
    expect(options.models[0]).toMatchObject({ id: 'test/model', isDefault: true })
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
    // OMP shares the one Pi-family adapter: same instance, same capability gate.
    expect(router.supportsCreate?.(LOCAL, 'omp')).toBe(true)
    expect(router.supportsCreate?.(LOCAL, 'codex')).toBe(true)
    expect(router.supportsCreate?.(LOCAL, 'unknown-agent')).toBe(false)
    const withoutPi = new StructuredAgentSessionAdapterRouter({ codex, claude }, async () => {})
    expect(withoutPi.supportsCreate?.(LOCAL, 'pi')).toBe(false)
    expect(withoutPi.supportsCreate?.(LOCAL, 'omp')).toBe(false)
  })

  it('forwards history resume reads to the owning adapter', async () => {
    const readResumeHistory = vi.fn(
      async (): Promise<{ rows: { id: string; role: string; text: string }[]; leafId: string }> => ({
        rows: [],
        leafId: 'leaf-1'
      })
    )
    const pi = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend: fakeBackend({ readResumeHistory }),
      readProcessStartTime: async () => 1
    })
    const codex = {
      acquire: vi.fn(async () => ({ process: { pid: 1 } }) as never),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsLocation: () => true
    } as unknown as StructuredAgentSessionAdapter
    const router = new StructuredAgentSessionAdapterRouter(
      { codex, claude: codex, pi },
      async () => {}
    )
    await router.acquire({ identity: freshIdentity('ses-1'), fence: 0, spawnToken: 'spawn-1' })
    await router.readResumeHistory({ sessionId: 'ses-1', fence: 0 })
    expect(readResumeHistory).toHaveBeenCalledWith({ orcaSessionId: 'ses-1' })
  })
})

describe('PiStructuredSessionAdapter OMP discriminant (PIF-1)', () => {
  function ompFreshIdentity(sessionId: string): AgentSessionJournalIdentity {
    return {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'omp',
      providerHandle: { kind: 'opaque', agent: 'omp', value: 'pending' }
    }
  }

  function ompResumeIdentity(sessionId: string): AgentSessionJournalIdentity {
    return {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'omp',
      providerHandle: { kind: 'opaque', agent: 'omp', value: 'omp:omp-ses-1' }
    }
  }

  function ompBackend(): PiStructuredBackend {
    return fakeBackend({
      acquire: async () => ({
        piSessionId: 'omp-ses-1',
        leafId: 'leaf-1',
        pid: 4242,
        sessionFilePath: '/tmp/omp-ses-1.jsonl'
      })
    })
  }

  it('claims omp alongside pi on proven local locations, never globally', () => {
    const adapter = new PiStructuredSessionAdapter({ resolveWorkspacePath: () => '/tmp/ws' })
    expect(adapter.supportsCreate?.(LOCAL, 'omp')).toBe(true)
    expect(adapter.supportsCreate?.(LOCAL, 'pi')).toBe(true)
    expect(adapter.supportsCreate?.(LOCAL, 'codex')).toBe(false)
    expect(adapter.supportsCreate?.({ ...LOCAL, wslDistro: 'Ubuntu' }, 'omp')).toBe(false)
    expect(adapter.supportsCreate?.({ ...LOCAL, executionHostId: 'ssh:host-1' }, 'omp')).toBe(
      false
    )
  })

  it('mints an omp link with the exact session file and answers dispatch as omp', async () => {
    const adapter = adapterWithFake(ompBackend())
    const acquired = await adapter.acquire({
      identity: ompFreshIdentity('ses-omp'),
      fence: 7,
      spawnToken: 'spawn-1'
    })
    expect(acquired.link.handle).toEqual({
      provider: 'omp',
      sessionId: 'omp-ses-1',
      leafId: 'leaf-1',
      sessionFile: '/tmp/omp-ses-1.jsonl'
    })
    await expect(
      adapter.dispatch({ sessionId: 'ses-omp', clientMessageId: 'c1', body: textBody('hi'), fence: 7 })
    ).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { provider: 'legacy', agent: 'omp', sessionId: 'omp-ses-1' }
    })
  })

  it('resumes the exact omp session when the host-owned file accompanies the resume identity', async () => {
    const acquire = vi.fn(async () => ({
      piSessionId: 'omp-ses-1',
      leafId: 'leaf-2',
      pid: 4242,
      sessionFilePath: '/tmp/omp-ses-1.jsonl'
    }))
    const adapter = adapterWithFake(fakeBackend({ acquire }))
    const acquired = await adapter.acquire({
      identity: ompResumeIdentity('ses-omp'),
      fence: 4,
      spawnToken: 'spawn-2',
      resumeSessionFile: '/tmp/omp-ses-1.jsonl'
    })
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        resumePiSessionId: 'omp-ses-1',
        resumeSessionFile: '/tmp/omp-ses-1.jsonl'
      })
    )
    expect(acquired.link.origin).toBe('resumed')
    expect(acquired.link.handle).toMatchObject({ provider: 'omp', sessionId: 'omp-ses-1' })
  })

  it('refuses a cross-provider resume instead of opening a Pi file with OMP', async () => {
    const adapter = adapterWithFake(ompBackend())
    const mixed: AgentSessionJournalIdentity = {
      ...ompFreshIdentity('ses-omp'),
      providerHandle: { kind: 'opaque', agent: 'omp', value: 'pi:pi-ses-1' }
    }
    await expect(
      adapter.acquire({
        identity: mixed,
        fence: 0,
        spawnToken: 'spawn-1',
        resumeSessionFile: '/tmp/pi-ses-1.jsonl'
      })
    ).rejects.toThrow('mixes pi session with omp acquisition')
  })

  it('reaps the child and fails closed when the backend reports no session file', async () => {
    const close = vi.fn(async () => true)
    const backend = fakeBackend({
      acquire: async () => ({ piSessionId: 'omp-ses-1', leafId: 'leaf-1', pid: 4242 }),
      close
    })
    const adapter = adapterWithFake(backend)
    await expect(
      adapter.acquire({ identity: ompFreshIdentity('ses-omp'), fence: 0, spawnToken: 'spawn-1' })
    ).rejects.toThrow('PI_STATE_FAILED')
    expect(close).toHaveBeenCalledWith({ orcaSessionId: 'ses-omp' })
  })

  it('routes pi and omp acquisitions through one router adapter without touching external', async () => {
    const codex = {
      acquire: vi.fn(async () => ({ process: { pid: 1 } }) as never),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsLocation: () => true
    } as unknown as StructuredAgentSessionAdapter
    const pi = adapterWithFake(ompBackend())
    const router = new StructuredAgentSessionAdapterRouter({ codex, claude: codex, pi }, async () => {})
    expect(router.supportsCreate?.(LOCAL, 'pi')).toBe(true)
    expect(router.supportsCreate?.(LOCAL, 'omp')).toBe(true)
    const piAcquired = await router.acquire({
      identity: freshIdentity('ses-pi'),
      fence: 0,
      spawnToken: 'spawn-pi'
    })
    // The shared fake backend answers every fresh acquire the same way; the durable
    // discriminant still routes unchanged per acquisition.
    expect(piAcquired.link.handle).toMatchObject({ provider: 'pi' })
    await expect(
      router.dispatch({
        sessionId: 'ses-pi',
        clientMessageId: 'c1',
        body: textBody('hi'),
        fence: 0
      })
    ).resolves.toMatchObject({ state: 'accepted' })
  })
})
