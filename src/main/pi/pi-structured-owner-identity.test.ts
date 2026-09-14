import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionProviderHandleKey,
  agentSessionProviderHandleRoot,
  appendAgentSessionProviderHandleLink,
  isAgentSessionHandleProvider,
  isAgentSessionProviderHandle
} from '../../shared/agent-session-provider-handle'
import { piProcessIdentity, piProviderHandleLink } from './pi-structured-owner-identity'

const IDENTITY = {
  sessionId: 'session-pi-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'pi' as const,
  providerHandle: { kind: 'opaque' as const, agent: 'pi' as const, value: 'pi:pi-ses-1' }
}

describe('Pi owner identity', () => {
  it('mints a durable link naming the exact Pi session and leaf', () => {
    const link = piProviderHandleLink({ sessionId: 'pi-ses-1', leafId: 'leaf-9', resumed: false, fence: 3, observedAt: 100 })
    expect(link.handle).toEqual({ provider: 'pi', sessionId: 'pi-ses-1', leafId: 'leaf-9' })
    expect(link.origin).toBe('created')
    expect(link.mintedAtFence).toBe(3)
    const resumed = piProviderHandleLink({ sessionId: 'pi-ses-1', leafId: 'leaf-10', resumed: true, fence: 4, observedAt: 200 })
    expect(resumed.origin).toBe('resumed')
  })

  it('carries the host-observed session file without changing handle identity', () => {
    const link = piProviderHandleLink({
      sessionId: 'pi-ses-1',
      leafId: 'leaf-9',
      resumed: false,
      fence: 3,
      observedAt: 100,
      sessionFile: '/tmp/pi-ses-1.jsonl'
    })
    expect(link.handle).toMatchObject({ provider: 'pi', sessionFile: '/tmp/pi-ses-1.jsonl' })
    const bare = piProviderHandleLink({
      sessionId: 'pi-ses-1',
      leafId: 'leaf-9',
      resumed: false,
      fence: 3,
      observedAt: 100
    })
    expect(agentSessionProviderHandleKey(link.handle)).toBe(
      agentSessionProviderHandleKey(bare.handle)
    )
    expect(agentSessionProviderHandleRoot(link.handle)).toBe(
      agentSessionProviderHandleRoot(bare.handle)
    )
  })

  it('records the observed start time alongside the spawn token', async () => {
    await expect(
      piProcessIdentity({ identity: IDENTITY, spawnToken: 'spawn-a', pid: 4242 }, async () => 123)
    ).resolves.toEqual({ hostId: 'local', pid: 4242, processStartTimeMs: 123, spawnToken: 'spawn-a' })
  })

  it('refuses an owner whose start time is unreadable rather than latch indeterminate', async () => {
    const readStartTime = vi.fn(async () => null)
    await expect(
      piProcessIdentity({ identity: IDENTITY, spawnToken: 'spawn-a', pid: 4242 }, readStartTime)
    ).rejects.toThrow('start time')
    expect(readStartTime).toHaveBeenCalledTimes(3)
  })

  it('recognises Pi provider handles without impersonating Codex', () => {
    expect(isAgentSessionHandleProvider('pi')).toBe(true)
    expect(isAgentSessionHandleProvider('unknown-provider')).toBe(false)
    expect(
      isAgentSessionProviderHandle({ provider: 'pi', sessionId: 'pi-ses-1', leafId: 'leaf-9' })
    ).toBe(true)
    expect(
      isAgentSessionProviderHandle({ provider: 'pi', sessionId: 'pi-ses-1', leafId: '' })
    ).toBe(false)
    expect(isAgentSessionProviderHandle({ provider: 'pi', sessionId: '', leafId: null })).toBe(false)
  })

  it('keys Pi handles by session and leaf, roots by session only', () => {
    const a = { provider: 'pi' as const, sessionId: 'pi-ses-1', leafId: 'leaf-9' }
    const b = { provider: 'pi' as const, sessionId: 'pi-ses-1', leafId: 'leaf-10' }
    const c = { provider: 'pi' as const, sessionId: 'pi-ses-2', leafId: 'leaf-9' }
    expect(agentSessionProviderHandleKey(a)).not.toBe(agentSessionProviderHandleKey(b))
    expect(agentSessionProviderHandleRoot(a)).toBe(agentSessionProviderHandleRoot(b))
    expect(agentSessionProviderHandleRoot(a)).not.toBe(agentSessionProviderHandleRoot(c))
  })

  it('treats a Pi resume that changes the session root as a fork, never a resume', () => {
    const now = 1000
    const chain = appendAgentSessionProviderHandleLink([], piProviderHandleLink({ sessionId: 'pi-ses-1', leafId: null, resumed: false, fence: 0, observedAt: now }))
    expect(() =>
      appendAgentSessionProviderHandleLink(
        chain,
        piProviderHandleLink({ sessionId: 'pi-ses-2', leafId: null, resumed: true, fence: 1, observedAt: now + 1 })
      )
    ).toThrow('agent_session_provider_handle_forked')
  })
})
