import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { StructuredAgentSessionConversationNames } from './structured-agent-session-conversation-name'

const SESSION = 'session-1'

function harness(
  options: {
    stored?: string | undefined
    setConversationName?: (
      sessionId: string,
      conversationName: string,
      now: number
    ) => Promise<AgentSessionRecord>
  } = {}
) {
  const stored = { conversationName: options.stored }
  const setConversationName =
    options.setConversationName ??
    vi.fn(async (_sessionId: string, conversationName: string) => {
      stored.conversationName = conversationName
      return {} as AgentSessionRecord
    })
  const onChanged = vi.fn()
  const names = new StructuredAgentSessionConversationNames({
    store: {
      getRecord: () => stored as AgentSessionRecord,
      setConversationName: setConversationName as never
    },
    now: () => 5,
    onChanged
  })
  return { names, onChanged, setConversationName, stored }
}

describe('StructuredAgentSessionConversationNames', () => {
  it('persists a published name and announces the change once', async () => {
    const { names, onChanged, setConversationName, stored } = harness()

    await names.publish(SESSION, '  Fix the\nlease probe ')

    expect(setConversationName).toHaveBeenCalledWith(SESSION, 'Fix the lease probe', 5)
    expect(stored.conversationName).toBe('Fix the lease probe')
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(SESSION, 'Fix the lease probe')
  })

  it('does not rewrite or re-announce a name the record already holds', async () => {
    const { names, onChanged, setConversationName } = harness({ stored: 'Fix the lease probe' })

    await names.publish(SESSION, 'Fix the lease probe')

    expect(setConversationName).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('ignores a report that carries no usable name', async () => {
    const { names, onChanged, setConversationName } = harness()

    await names.publish(SESSION, '')
    await names.publish(SESSION, null)
    await names.publish(SESSION, { name: 'nope' })

    expect(setConversationName).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('keeps a store failure off the caller and announces nothing', async () => {
    const { names, onChanged } = harness({
      setConversationName: vi.fn(async () => {
        throw new Error('agent_session_identity_required')
      })
    })

    await expect(names.publish(SESSION, 'Fix the lease probe')).resolves.toBeUndefined()
    expect(onChanged).not.toHaveBeenCalled()
  })
})
