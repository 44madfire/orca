import { describe, expect, it } from 'vitest'
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

function setup(initSessionId = childId, initProof: 'none' | undefined = undefined) {
  const fake = fakeClaude({ initSessionId, initProof })
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
    readProcessStartTime: async () => 123
  })
  return { fake, adapter }
}

describe('Claude fork acquisition', () => {
  it('opens a fork without requiring a lazily created child transcript', async () => {
    const { fake, adapter } = setup(childId, 'none')
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
      expect(fake.connections[0]?.sent).toEqual([])
      expect(fake.connections[0]?.launch.options).toMatchObject({
        forkSession: true,
        resume: PROVIDER_SESSION_ID,
        resumeSessionAt: 'selected',
        sessionId: childId
      })
    } finally {
      await adapter.closeSession(sessionId)
    }
  })

  it('closes a child that announces an unexpected provider identity', async () => {
    const { fake, adapter } = setup(PROVIDER_SESSION_ID)
    await expect(
      adapter.acquire({
        identity: identityFor(sessionId),
        fence: 1,
        spawnToken: 'child-token',
        fork
      })
    ).rejects.toThrow()
    expect(fake.connections[0]?.closed).toBe(true)
  })
})
