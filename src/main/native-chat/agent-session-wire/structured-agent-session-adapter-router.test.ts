import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'

function claudeIdentity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'claude',
    providerHandle: { kind: 'claude', sessionId: 'provider-session-1', leafUuid: null }
  }
}

function acquisition(fence: number, spawnToken: string): AgentSessionAcquisition {
  return {
    process: { hostId: 'local', pid: 1, processStartTimeMs: 1, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'claude', sessionId: 'provider-session-1', leafUuid: null },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: 1
    }
  }
}

function adapterOf(
  releaseAcquisition: StructuredAgentSessionAdapter['releaseAcquisition']
): StructuredAgentSessionAdapter {
  return {
    acquire: vi.fn(async ({ fence, spawnToken }) => acquisition(fence, spawnToken)),
    releaseAcquisition,
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
}

describe('StructuredAgentSessionAdapterRouter.releaseAcquisition', () => {
  it('drops the owner even when its release reports a typed failure', async () => {
    const failure = new Error('root exited')
    const claude = adapterOf(vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(false))
    const codex = adapterOf(vi.fn(async () => false))
    const router = new StructuredAgentSessionAdapterRouter({ claude, codex }, async () => {})
    const identity = claudeIdentity('session-1')
    await router.acquire({ identity, fence: 1, spawnToken: 'spawn-1' })

    await expect(router.releaseAcquisition({ sessionId: 'session-1' })).rejects.toBe(failure)
    // With no owner left, a later release asks every adapter instead of the stale one.
    await expect(router.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(false)
    expect(claude.releaseAcquisition).toHaveBeenCalledTimes(2)
    expect(codex.releaseAcquisition).toHaveBeenCalledTimes(1)
  })
})

describe('StructuredAgentSessionAdapterRouter.closeSession', () => {
  it('retains the owner after an unproven close so a later retry reaches the same adapter', async () => {
    const claude = adapterOf(vi.fn(async () => true))
    const closeSession = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const dispatch = vi.fn().mockResolvedValue({ state: 'unknown', reason: 'test' })
    claude.closeSession = closeSession
    claude.dispatch = dispatch
    const codex = adapterOf(vi.fn(async () => false))
    const router = new StructuredAgentSessionAdapterRouter({ claude, codex }, async () => {})
    const identity = claudeIdentity('session-1')
    await router.acquire({ identity, fence: 1, spawnToken: 'spawn-1' })

    await expect(router.closeSession('session-1')).resolves.toBe(false)
    await expect(
      router.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: { kind: 'message', role: 'user', blocks: [] },
        fence: 1
      })
    ).resolves.toMatchObject({ state: 'unknown' })
    await expect(router.closeSession('session-1')).resolves.toBe(true)
    expect(closeSession).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('retains a stop proof across journal-close failure until the host acknowledges release', async () => {
    const closeSession = vi.fn(async () => true)
    const closeJournal = vi.fn(async () => {
      throw new Error('journal close failed')
    })
    const claude = adapterOf(vi.fn(async () => true))
    claude.closeSession = closeSession
    const router = new StructuredAgentSessionAdapterRouter(
      { claude, codex: adapterOf(vi.fn(async () => false)) },
      async () => {}
    )
    const identity = claudeIdentity('session-1')
    await router.acquire({ identity, fence: 1, spawnToken: 'spawn-1' })

    await expect(router.closeSession('session-1')).resolves.toBe(true)
    await expect(closeJournal()).rejects.toThrow('journal close failed')
    await expect(router.closeSession('session-1')).resolves.toBe(true)
    expect(closeSession).toHaveBeenCalledOnce()
    router.acknowledgeSessionRelease('session-1')
    await expect(router.closeSession('session-1')).resolves.toBe(false)

    await router.acquire({ identity, fence: 2, spawnToken: 'spawn-2' })
    await expect(router.closeSession('session-1')).resolves.toBe(true)
    expect(closeSession).toHaveBeenCalledTimes(2)
  })
})

describe('StructuredAgentSessionAdapterRouter optional lifecycle methods', () => {
  it.each([
    ['forceCloseSession', 'forceCloseSession'],
    ['disposeSession', 'disposeSession']
  ] as const)(
    '%s forwards to the owner and retains it until proven stopped',
    async (_label, method) => {
      const claude = adapterOf(vi.fn(async () => true))
      const stop = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      claude[method] = stop
      const dispatch = vi.fn().mockResolvedValue({ state: 'unknown', reason: 'test' })
      claude.dispatch = dispatch
      const codex = adapterOf(vi.fn(async () => false))
      const router = new StructuredAgentSessionAdapterRouter({ claude, codex }, async () => {})
      const identity = claudeIdentity('session-1')
      await router.acquire({ identity, fence: 1, spawnToken: 'spawn-1' })
      const stopSession = router[method]

      await expect(stopSession('session-1')).resolves.toBe(false)
      await expect(
        router.dispatch({
          sessionId: 'session-1',
          clientMessageId: 'client-1',
          body: { kind: 'message', role: 'user', blocks: [] },
          fence: 1
        })
      ).resolves.toMatchObject({ state: 'unknown' })
      await expect(stopSession('session-1')).resolves.toBe(true)
      expect(stop).toHaveBeenCalledTimes(2)
      expect(dispatch).toHaveBeenCalledOnce()
    }
  )

  it.each(['forceCloseSession', 'disposeSession'] as const)(
    'falls back to closeSession when an owner lacks %s',
    async (method) => {
      const closeSession = vi.fn().mockResolvedValue(true)
      const claude = adapterOf(vi.fn(async () => true))
      claude.closeSession = closeSession
      const codex = adapterOf(vi.fn(async () => false))
      const router = new StructuredAgentSessionAdapterRouter({ claude, codex }, async () => {})
      await router.acquire({
        identity: claudeIdentity('session-1'),
        fence: 1,
        spawnToken: 'spawn-1'
      })
      const stopSession = router[method]

      await expect(stopSession('session-1')).resolves.toBe(true)
      expect(closeSession).toHaveBeenCalledWith('session-1')
    }
  )
})

describe('StructuredAgentSessionAdapterRouter.closeAll', () => {
  it('refuses to acquire once the global close proof is published', async () => {
    const acquire = vi.fn(async ({ fence, spawnToken }) => acquisition(fence, spawnToken))
    const claude = adapterOf(vi.fn(async () => true))
    claude.acquire = acquire
    const router = new StructuredAgentSessionAdapterRouter(
      { claude, codex: adapterOf(vi.fn(async () => false)) },
      async () => undefined
    )
    await router.closeAll()

    await expect(
      router.acquire({
        identity: claudeIdentity('session-1'),
        fence: 1,
        spawnToken: 'spawn-1'
      })
    ).rejects.toThrow('router is closed')
    expect(acquire).not.toHaveBeenCalled()
  })

  it('keeps a per-session stop proof and reports no stop for a session it never routed', async () => {
    const claude = adapterOf(vi.fn(async () => true))
    const closeAdapters = vi.fn(async () => undefined)
    const router = new StructuredAgentSessionAdapterRouter(
      { claude, codex: adapterOf(vi.fn(async () => false)) },
      closeAdapters
    )
    await router.acquire({
      identity: claudeIdentity('session-1'),
      fence: 1,
      spawnToken: 'spawn-1'
    })

    await router.closeAll()

    // The routed session carries the shutdown's own exit proof; the other two are sessions this
    // router has no record of, and an absent record is not a stop it can report.
    await expect(router.closeSession('session-1')).resolves.toBe(true)
    await expect(router.closeSession('never-routed')).resolves.toBe(false)
    router.acknowledgeSessionRelease('session-1')
    await expect(router.closeSession('session-1')).resolves.toBe(false)
    await router.closeAll()
    expect(closeAdapters).toHaveBeenCalledOnce()
  })

  it('asks the adapters to release an unrouted session rather than answering from the close proof', async () => {
    const claudeRelease = vi.fn(async () => true)
    const codexRelease = vi.fn(async () => false)
    const router = new StructuredAgentSessionAdapterRouter(
      { claude: adapterOf(claudeRelease), codex: adapterOf(codexRelease) },
      async () => undefined
    )
    await router.closeAll()

    await expect(router.releaseAcquisition({ sessionId: 'never-routed' })).resolves.toBe(true)
    expect(claudeRelease).toHaveBeenCalledWith({ sessionId: 'never-routed' })
    expect(codexRelease).toHaveBeenCalledWith({ sessionId: 'never-routed' })
  })

  it('retains live routes and publishes no global proof when closeAll fails', async () => {
    const failure = new Error('adapter shutdown failed')
    const claude = adapterOf(vi.fn(async () => true))
    const dispatch = vi.fn().mockResolvedValue({ state: 'unknown', reason: 'test' })
    const closeSession = vi.fn(async () => true)
    claude.dispatch = dispatch
    claude.closeSession = closeSession
    const router = new StructuredAgentSessionAdapterRouter(
      { claude, codex: adapterOf(vi.fn(async () => false)) },
      vi.fn(async () => {
        throw failure
      })
    )
    await router.acquire({
      identity: claudeIdentity('session-1'),
      fence: 1,
      spawnToken: 'spawn-1'
    })

    await expect(router.closeAll()).rejects.toBe(failure)

    await expect(router.closeSession('never-routed')).resolves.toBe(false)
    await expect(
      router.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: { kind: 'message', role: 'user', blocks: [] },
        fence: 1
      })
    ).resolves.toMatchObject({ state: 'unknown' })
    await expect(router.closeSession('session-1')).resolves.toBe(true)
    expect(closeSession).toHaveBeenCalledOnce()
  })

  it('keeps the global proof when an acquisition lands mid-close', async () => {
    let resolveAcquire!: (value: AgentSessionAcquisition) => void
    const closeSession = vi.fn(async () => true)
    const claude = adapterOf(vi.fn(async () => true))
    claude.closeSession = closeSession
    claude.acquire = vi.fn(
      () =>
        new Promise<AgentSessionAcquisition>((resolve) => {
          resolveAcquire = resolve
        })
    )
    const router = new StructuredAgentSessionAdapterRouter(
      { claude, codex: adapterOf(vi.fn(async () => false)) },
      async () => undefined
    )
    const acquiring = router.acquire({
      identity: claudeIdentity('session-1'),
      fence: 2,
      spawnToken: 'spawn-2'
    })

    await router.closeAll()
    resolveAcquire(acquisition(2, 'spawn-2'))

    // The route is NOT published behind a closed adapter, so nothing routes back out to it — and
    // with no route the router has nothing to stop and no stop to report.
    await expect(acquiring).rejects.toThrow('router is closed')
    await expect(router.closeSession('session-1')).resolves.toBe(false)
    expect(closeSession).not.toHaveBeenCalled()
  })
})

describe('StructuredAgentSessionAdapterRouter Pi-family routing (pi + omp)', () => {
  const LOCAL = {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'folder'
  } as const

  function familyIdentity(sessionId: string, agent: 'pi' | 'omp'): AgentSessionJournalIdentity {
    return {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent,
      providerHandle: { kind: 'opaque', agent, value: 'pending' }
    }
  }

  function piFamilyAdapter(seen: { acquires: string[] }): StructuredAgentSessionAdapter {
    const owned = new Set<string>()
    return {
      supportsCreate: (_location, agent) => agent === 'pi' || agent === 'omp',
      supportsLocation: () => true,
      acquire: async (input) => {
        seen.acquires.push(`${input.identity.agent}:${input.identity.sessionId}`)
        const provider = input.identity.agent === 'omp' ? ('omp' as const) : ('pi' as const)
        owned.add(input.identity.sessionId)
        return {
          process: {
            hostId: 'local',
            pid: 7,
            processStartTimeMs: 9,
            spawnToken: input.spawnToken
          },
          link: {
            linkId: `link-${input.fence}`,
            handle: {
              provider,
              sessionId: `${provider}-ses-1`,
              leafId: 'leaf-1',
              sessionFile: `/tmp/${provider}-ses-1.jsonl`
            },
            origin: 'created' as const,
            mintedAtFence: input.fence,
            observedAt: 1
          }
        }
      },
      dispatch: async (input) => {
        if (!owned.has(input.sessionId)) {
          throw new Error(`no live pi-family session for ${input.sessionId}`)
        }
        return { state: 'unknown', reason: 'test' }
      },
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => undefined,
      setOption: async () => undefined,
      closeSession: async (sessionId) => owned.delete(sessionId)
    }
  }

  it('selects the same installed adapter for pi and omp with the discriminant unchanged', async () => {
    const seen: { acquires: string[] } = { acquires: [] }
    const family = piFamilyAdapter(seen)
    const router = new StructuredAgentSessionAdapterRouter(
      {
        claude: adapterOf(vi.fn(async () => false)),
        codex: adapterOf(vi.fn(async () => false)),
        pi: family
      },
      async () => {}
    )
    expect(router.supportsCreate?.(LOCAL, 'pi')).toBe(true)
    expect(router.supportsCreate?.(LOCAL, 'omp')).toBe(true)

    const piAcquired = await router.acquire({
      identity: familyIdentity('session-pi', 'pi'),
      fence: 1,
      spawnToken: 'spawn-pi'
    })
    const ompAcquired = await router.acquire({
      identity: familyIdentity('session-omp', 'omp'),
      fence: 2,
      spawnToken: 'spawn-omp'
    })
    // Acquisition routes the durable provider discriminant unchanged to one adapter.
    expect(seen.acquires).toEqual(['pi:session-pi', 'omp:session-omp'])
    expect(piAcquired.link.handle).toMatchObject({ provider: 'pi' })
    expect(ompAcquired.link.handle).toMatchObject({ provider: 'omp' })
    // Live per-session operations route to the adapter that owns the acquisition.
    await expect(
      router.dispatch({
        sessionId: 'session-pi',
        clientMessageId: 'client-1',
        body: { kind: 'message', role: 'user', blocks: [] },
        fence: 1
      })
    ).resolves.toMatchObject({ state: 'unknown' })
    await expect(
      router.dispatch({
        sessionId: 'session-omp',
        clientMessageId: 'client-2',
        body: { kind: 'message', role: 'user', blocks: [] },
        fence: 2
      })
    ).resolves.toMatchObject({ state: 'unknown' })
  })

  it('serves both discriminants from whichever key holds the shared adapter', async () => {
    const seen: { acquires: string[] } = { acquires: [] }
    const router = new StructuredAgentSessionAdapterRouter(
      {
        claude: adapterOf(vi.fn(async () => false)),
        codex: adapterOf(vi.fn(async () => false)),
        omp: piFamilyAdapter(seen)
      },
      async () => {}
    )
    expect(router.supportsCreate?.(LOCAL, 'pi')).toBe(true)
    expect(router.supportsCreate?.(LOCAL, 'omp')).toBe(true)
    await router.acquire({
      identity: familyIdentity('session-pi', 'pi'),
      fence: 1,
      spawnToken: 's1'
    })
    await router.acquire({
      identity: familyIdentity('session-omp', 'omp'),
      fence: 2,
      spawnToken: 's2'
    })
    expect(seen.acquires).toEqual(['pi:session-pi', 'omp:session-omp'])
  })

  it('fails closed for both providers when no Pi-family adapter is installed', async () => {
    const router = new StructuredAgentSessionAdapterRouter(
      { claude: adapterOf(vi.fn(async () => false)), codex: adapterOf(vi.fn(async () => false)) },
      async () => {}
    )
    expect(router.supportsCreate?.(LOCAL, 'pi')).toBe(false)
    expect(router.supportsCreate?.(LOCAL, 'omp')).toBe(false)
    await expect(
      router.acquire({ identity: familyIdentity('session-pi', 'pi'), fence: 1, spawnToken: 's1' })
    ).rejects.toThrow('structured sessions do not support pi')
    await expect(
      router.acquire({ identity: familyIdentity('session-omp', 'omp'), fence: 2, spawnToken: 's2' })
    ).rejects.toThrow('structured sessions do not support omp')
  })

  it('never falls through to external for pi or omp', async () => {
    const externalAcquire = vi.fn(async ({ fence, spawnToken }) => acquisition(fence, spawnToken))
    const external = adapterOf(vi.fn(async () => false))
    external.acquire = externalAcquire
    const seen: { acquires: string[] } = { acquires: [] }
    const router = new StructuredAgentSessionAdapterRouter(
      {
        claude: adapterOf(vi.fn(async () => false)),
        codex: adapterOf(vi.fn(async () => false)),
        external,
        pi: piFamilyAdapter(seen)
      },
      async () => {}
    )
    await router.acquire({
      identity: familyIdentity('session-pi', 'pi'),
      fence: 1,
      spawnToken: 's1'
    })
    await router.acquire({
      identity: familyIdentity('session-omp', 'omp'),
      fence: 2,
      spawnToken: 's2'
    })
    expect(externalAcquire).not.toHaveBeenCalled()
    expect(seen.acquires).toEqual(['pi:session-pi', 'omp:session-omp'])

    const withoutFamily = new StructuredAgentSessionAdapterRouter(
      {
        claude: adapterOf(vi.fn(async () => false)),
        codex: adapterOf(vi.fn(async () => false)),
        external
      },
      async () => {}
    )
    await expect(
      withoutFamily.acquire({
        identity: familyIdentity('session-pi', 'pi'),
        fence: 1,
        spawnToken: 's1'
      })
    ).rejects.toThrow('structured sessions do not support pi')
    await expect(
      withoutFamily.acquire({
        identity: familyIdentity('session-omp', 'omp'),
        fence: 2,
        spawnToken: 's2'
      })
    ).rejects.toThrow('structured sessions do not support omp')
    expect(externalAcquire).not.toHaveBeenCalled()
  })

  it('leaves Claude/Codex routing on their own adapters', async () => {
    const seen: { acquires: string[] } = { acquires: [] }
    const claudeAcquire = vi.fn(async ({ fence, spawnToken }) => acquisition(fence, spawnToken))
    const codexAcquire = vi.fn(async ({ fence, spawnToken }) => acquisition(fence, spawnToken))
    const claude = adapterOf(vi.fn(async () => false))
    claude.acquire = claudeAcquire
    const codex = adapterOf(vi.fn(async () => false))
    codex.acquire = codexAcquire
    const router = new StructuredAgentSessionAdapterRouter(
      { claude, codex, pi: piFamilyAdapter(seen) },
      async () => {}
    )
    await router.acquire({ identity: claudeIdentity('session-claude'), fence: 1, spawnToken: 's1' })
    await router.acquire({
      identity: { ...claudeIdentity('session-codex'), agent: 'codex' },
      fence: 2,
      spawnToken: 's2'
    })
    expect(claudeAcquire).toHaveBeenCalledOnce()
    expect(codexAcquire).toHaveBeenCalledOnce()
    expect(seen.acquires).toEqual([])
  })

  it('keeps stop semantics on Pi-family routes: no route fabricates a close', async () => {
    const seen: { acquires: string[] } = { acquires: [] }
    const router = new StructuredAgentSessionAdapterRouter(
      {
        claude: adapterOf(vi.fn(async () => false)),
        codex: adapterOf(vi.fn(async () => false)),
        pi: piFamilyAdapter(seen)
      },
      async () => {}
    )
    await router.acquire({
      identity: familyIdentity('session-omp', 'omp'),
      fence: 2,
      spawnToken: 's2'
    })

    await expect(router.closeSession('never-routed')).resolves.toBe(false)
    await expect(router.closeSession('session-omp')).resolves.toBe(true)
    await expect(router.closeSession('session-omp')).resolves.toBe(true)
    router.acknowledgeSessionRelease('session-omp')
    await expect(router.closeSession('session-omp')).resolves.toBe(false)
  })
})

