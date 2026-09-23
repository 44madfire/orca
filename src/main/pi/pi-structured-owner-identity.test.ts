import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionProviderHandleKey,
  agentSessionProviderHandleRoot,
  agentSessionProviderHandlesEqual,
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

const FILE = '/tmp/pi-ses-1.jsonl'

describe('Pi owner identity', () => {
  it('mints a durable link naming the exact Pi session, leaf, and session file', () => {
    const link = piProviderHandleLink({
      sessionId: 'pi-ses-1',
      leafId: 'leaf-9',
      resumed: false,
      fence: 3,
      observedAt: 100,
      sessionFile: FILE
    })
    expect(link.handle).toEqual({
      provider: 'pi',
      sessionId: 'pi-ses-1',
      leafId: 'leaf-9',
      sessionFile: FILE
    })
    expect(link.origin).toBe('created')
    expect(link.mintedAtFence).toBe(3)
    const resumed = piProviderHandleLink({
      sessionId: 'pi-ses-1',
      leafId: 'leaf-10',
      resumed: true,
      fence: 4,
      observedAt: 200,
      sessionFile: FILE
    })
    expect(resumed.origin).toBe('resumed')
  })

  it('mints an omp link under the omp discriminant, never pi', () => {
    const link = piProviderHandleLink({
      provider: 'omp',
      sessionId: 'omp-ses-1',
      leafId: 'leaf-9',
      resumed: false,
      fence: 3,
      observedAt: 100,
      sessionFile: '/tmp/omp-ses-1.jsonl'
    })
    expect(link.handle).toMatchObject({ provider: 'omp', sessionId: 'omp-ses-1' })
    expect(link.linkId.startsWith('omp-')).toBe(true)
  })

  it('names the session file in the handle key but keeps the root on provider + session', () => {
    const withFile = piProviderHandleLink({
      sessionId: 'pi-ses-1',
      leafId: 'leaf-9',
      resumed: false,
      fence: 3,
      observedAt: 100,
      sessionFile: FILE
    })
    const otherFile = piProviderHandleLink({
      sessionId: 'pi-ses-1',
      leafId: 'leaf-9',
      resumed: false,
      fence: 3,
      observedAt: 100,
      sessionFile: '/tmp/pi-ses-1-other.jsonl'
    })
    // The exact locator names the writer target, so a changed file is a new handle...
    expect(agentSessionProviderHandleKey(withFile.handle)).not.toBe(
      agentSessionProviderHandleKey(otherFile.handle)
    )
    // ...but the session root never moves under a file change.
    expect(agentSessionProviderHandleRoot(withFile.handle)).toBe(
      agentSessionProviderHandleRoot(otherFile.handle)
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

  it('recognises Pi and OMP providers without impersonating Codex', () => {
    expect(isAgentSessionHandleProvider('pi')).toBe(true)
    expect(isAgentSessionHandleProvider('omp')).toBe(true)
    expect(isAgentSessionHandleProvider('unknown-provider')).toBe(false)
    expect(
      isAgentSessionProviderHandle({
        provider: 'pi',
        sessionId: 'pi-ses-1',
        leafId: 'leaf-9',
        sessionFile: FILE
      })
    ).toBe(true)
    expect(
      isAgentSessionProviderHandle({
        provider: 'omp',
        sessionId: 'omp-ses-1',
        leafId: null,
        sessionFile: '/tmp/omp-ses-1.jsonl'
      })
    ).toBe(true)
    // The exact file is required: a Pi-family handle without one is unresumable.
    expect(
      isAgentSessionProviderHandle({ provider: 'pi', sessionId: 'pi-ses-1', leafId: 'leaf-9' })
    ).toBe(false)
    expect(
      isAgentSessionProviderHandle({
        provider: 'omp',
        sessionId: 'omp-ses-1',
        leafId: null,
        sessionFile: ''
      })
    ).toBe(false)
    expect(
      isAgentSessionProviderHandle({ provider: 'pi', sessionId: 'pi-ses-1', leafId: '' })
    ).toBe(false)
    expect(isAgentSessionProviderHandle({ provider: 'pi', sessionId: '', leafId: null })).toBe(
      false
    )
  })

  it('keys Pi handles by session, leaf, and file, and roots by provider + session only', () => {
    const a = { provider: 'pi' as const, sessionId: 'pi-ses-1', leafId: 'leaf-9', sessionFile: FILE }
    const b = {
      provider: 'pi' as const,
      sessionId: 'pi-ses-1',
      leafId: 'leaf-10',
      sessionFile: FILE
    }
    const c = { provider: 'pi' as const, sessionId: 'pi-ses-2', leafId: 'leaf-9', sessionFile: FILE }
    expect(agentSessionProviderHandleKey(a)).not.toBe(agentSessionProviderHandleKey(b))
    expect(agentSessionProviderHandleRoot(a)).toBe(agentSessionProviderHandleRoot(b))
    expect(agentSessionProviderHandleRoot(a)).not.toBe(agentSessionProviderHandleRoot(c))
  })

  it('never compares Pi and OMP handles as the same root, even with equal session ids', () => {
    const pi = { provider: 'pi' as const, sessionId: 'same-1', leafId: 'leaf-9', sessionFile: FILE }
    const omp = {
      provider: 'omp' as const,
      sessionId: 'same-1',
      leafId: 'leaf-9',
      sessionFile: '/tmp/omp-same-1.jsonl'
    }
    expect(agentSessionProviderHandleRoot(pi)).not.toBe(agentSessionProviderHandleRoot(omp))
    expect(agentSessionProviderHandleKey(pi)).not.toBe(agentSessionProviderHandleKey(omp))
    expect(agentSessionProviderHandlesEqual(pi, omp)).toBe(false)
  })

  it('treats a Pi resume that changes the session root as a fork, never a resume', () => {
    const now = 1000
    const chain = appendAgentSessionProviderHandleLink(
      [],
      piProviderHandleLink({
        sessionId: 'pi-ses-1',
        leafId: null,
        resumed: false,
        fence: 0,
        observedAt: now,
        sessionFile: FILE
      })
    )
    expect(() =>
      appendAgentSessionProviderHandleLink(
        chain,
        piProviderHandleLink({
          sessionId: 'pi-ses-2',
          leafId: null,
          resumed: true,
          fence: 1,
          observedAt: now + 1,
          sessionFile: '/tmp/pi-ses-2.jsonl'
        })
      )
    ).toThrow('agent_session_provider_handle_forked')
  })

  it('rejects a cross-provider resume where Claude/Codex mismatches are rejected', () => {
    const now = 1000
    const chain = appendAgentSessionProviderHandleLink(
      [],
      piProviderHandleLink({
        sessionId: 'pi-ses-1',
        leafId: null,
        resumed: false,
        fence: 0,
        observedAt: now,
        sessionFile: FILE
      })
    )
    expect(() =>
      appendAgentSessionProviderHandleLink(chain, {
        linkId: 'omp-1-x-empty',
        handle: {
          provider: 'omp',
          sessionId: 'pi-ses-1',
          leafId: null,
          sessionFile: '/tmp/omp-ses-1.jsonl'
        },
        origin: 'resumed',
        mintedAtFence: 1,
        observedAt: now + 1
      })
    ).toThrow('agent_session_provider_handle_provider_mismatch')
  })
})
