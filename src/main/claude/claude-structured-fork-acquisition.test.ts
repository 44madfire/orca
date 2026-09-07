import { describe, expect, it, vi } from 'vitest'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import { claudeSessionIdForOrcaSession } from './claude-structured-launch-resolution'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

const sessionId = 'forked-orca-session'
const childId = claudeSessionIdForOrcaSession(sessionId)
const fork = {
  source: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: 'latest' },
  throughId: 'selected',
  retainedItemIds: [`claude:${PROVIDER_SESSION_ID}:selected`]
} as const

function setup(proveFork: () => Promise<void>) {
  const fake = fakeClaude({ initSessionId: childId })
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: { resume: PROVIDER_SESSION_ID },
      cwd: '/workspace',
      claudeConfigDir: '/account',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: 'latest',
      resumed: true
    }),
    openConnection: fake.openConnection,
    readProcessStartTime: async () => 123,
    proveFork
  })
  return { fake, adapter }
}

describe('Claude fork acquisition', () => {
  it('opens a new provider session and proves the retained cursor before returning ownership', async () => {
    const prove = vi.fn(async () => {})
    const { fake, adapter } = setup(prove)
    try {
      const acquired = await adapter.acquire({
        identity: identityFor(sessionId),
        fence: 1,
        spawnToken: 'child-token',
        fork
      })
      expect(acquired.link.handle).toEqual({
        provider: 'claude',
        sessionId: childId,
        leafUuid: 'selected'
      })
      expect(fake.connections[0]?.launch.options).toMatchObject({
        forkSession: true,
        resume: PROVIDER_SESSION_ID,
        resumeSessionAt: 'selected',
        sessionId: childId
      })
      expect(prove).toHaveBeenCalledTimes(1)
    } finally {
      await adapter.closeSession(sessionId)
    }
  })

  it('closes an unproved child and refuses ownership when history ends at another UUID', async () => {
    const prove = vi.fn(async () => {
      throw new Error('agent_session_fork:proof-mismatch')
    })
    const { fake, adapter } = setup(prove)
    await expect(
      adapter.acquire({
        identity: identityFor(sessionId),
        fence: 1,
        spawnToken: 'child-token',
        fork
      })
    ).rejects.toThrow('proof-mismatch')
    expect(fake.connections[0]?.closed).toBe(true)
    expect(prove).toHaveBeenCalledTimes(1)
  })
})
