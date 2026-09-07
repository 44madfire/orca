import { describe, expect, it, vi } from 'vitest'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'
import { ClaudeRewindAttempt } from './claude-structured-rewind'
import { AgentSessionRewindRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

const intent = { targetUuid: 'kept', previousLeafUuid: 'tip', dropsTurn: 'drop' }

describe('Claude rewind acquisition', () => {
  it('executes a cursor resume in place and proves the exact target before publication', async () => {
    const fake = fakeClaude()
    const proof = vi.fn(async (_input: { intentionalRewindUuid?: string }) => 'kept')
    const adapter = adapterFor(
      fake,
      { resumed: true, resumeLeafUuid: 'tip' },
      [],
      [],
      undefined,
      proof
    )
    try {
      const acquired = await adapter.acquire({
        identity: identityFor(),
        fence: 7,
        spawnToken: 'spawn',
        rewind: intent
      })
      expect(acquired.link.handle).toMatchObject({
        provider: 'claude',
        sessionId: PROVIDER_SESSION_ID,
        leafUuid: 'kept'
      })
      expect(fake.connections[0]!.launch.options).toMatchObject({
        resume: PROVIDER_SESSION_ID,
        resumeSessionAt: 'kept',
        resumeDropsTurn: 'drop'
      })
      expect(fake.connections[0]!.launch.options).not.toHaveProperty('forkSession')
      expect(proof).toHaveBeenCalledWith(
        expect.objectContaining({ previousLeafUuid: 'tip', intentionalRewindUuid: 'kept' })
      )
      await adapter.closeSession('session-1')
      await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-next' })
      expect(fake.connections[1]!.launch.options).not.toHaveProperty('resumeDropsTurn')
      expect(
        proof.mock.calls.filter(([input]) => input.intentionalRewindUuid !== undefined)
      ).toHaveLength(1)
    } finally {
      await adapter.closeAll()
    }
  })
  it('recognizes the documented refusal and closes the failed child without retry', async () => {
    const fake = fakeClaude()
    const openConnection = fake.openConnection
    fake.openConnection = async (launch, handlers) => {
      const connection = await openConnection(launch, handlers)
      const initialize = connection.initializationResult
      connection.initializationResult = async (...args) => {
        const result = await initialize(...args)
        handlers?.onMessage?.({
          type: 'result',
          subtype: 'error_during_execution',
          session_id: PROVIDER_SESSION_ID,
          errors: ['Resume rejected by --resume-drops-turn: additional prompt observed']
        })
        return result
      }
      return connection
    }
    const proof = vi.fn(async (_input: { intentionalRewindUuid?: string }) => 'kept')
    const adapter = adapterFor(fake, { resumed: true }, [], [], undefined, proof)
    await expect(
      adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn', rewind: intent })
    ).rejects.toMatchObject({ rewindReason: 'provider-refused' })
    expect(fake.connections).toHaveLength(1)
    expect(fake.connections[0]?.closed).toBe(true)
    expect(proof).not.toHaveBeenCalled()
    await adapter.closeAll()
  })
  it('consumes proof authorization even if its first read fails', async () => {
    const proof = vi.fn(async () => {
      throw new Error('torn transcript')
    })
    const attempt = new ClaudeRewindAttempt(intent)
    const launch = {
      providerSessionId: PROVIDER_SESSION_ID,
      claudeConfigDir: '/claude',
      options: {},
      resumed: true,
      resumeLeafUuid: 'tip',
      cwd: '/workspace',
      pathToClaudeCodeExecutable: 'claude'
    }
    await expect(attempt.prove(launch, { readTranscriptLeaf: proof })).rejects.toBeInstanceOf(
      AgentSessionRewindRefusal
    )
    expect(await attempt.prove(launch, { readTranscriptLeaf: proof })).toBeNull()
    expect(proof).toHaveBeenCalledTimes(1)
  })
})
