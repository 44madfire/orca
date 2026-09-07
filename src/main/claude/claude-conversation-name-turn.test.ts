import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { startClaudeConversationNaming } from './claude-conversation-name-turn'
import type { ClaudeSession } from './claude-structured-session-state'

const SESSION = 'session-1'

const USER_TURN = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'fix the flaky lease probe' }]
} as unknown as AgentJournalMessageItem

function sessionWith(generateSessionTitle: ReturnType<typeof vi.fn>): ClaudeSession {
  return {
    namingAttempted: false,
    connection: { generateSessionTitle }
  } as unknown as ClaudeSession
}

/** Lets the fire-and-forget promise chain settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

describe('startClaudeConversationNaming', () => {
  it('asks the CLI to generate and persist a title, then reports it', async () => {
    const generateSessionTitle = vi.fn(async () => 'Lease probe flake')
    const session = sessionWith(generateSessionTitle)
    const onConversationName = vi.fn()

    startClaudeConversationNaming(SESSION, session, USER_TURN, { onConversationName })
    await settle()

    // `persist` is what writes the ai-title record a later attach reads back;
    // without it the name would live only in this process.
    expect(generateSessionTitle).toHaveBeenCalledWith(
      'fix the flaky lease probe',
      expect.objectContaining({ persist: true })
    )
    expect(onConversationName).toHaveBeenCalledExactlyOnceWith(SESSION, 'Lease probe flake')
  })

  it('passes the user text alone, imposing no title style of its own', async () => {
    const generateSessionTitle = vi.fn(async () => 'Lease probe flake')

    startClaudeConversationNaming(SESSION, sessionWith(generateSessionTitle), USER_TURN, {
      onConversationName: vi.fn()
    })
    await settle()

    // Claude's own titling is a short noun phrase; instructing it in Codex's
    // imperative-verb style here would fight the SDK's own prompt.
    expect(generateSessionTitle).toHaveBeenCalledWith(
      'fix the flaky lease probe',
      expect.anything()
    )
  })

  it('asks only once across a re-acquisition, which builds a NEW session object', async () => {
    const generateSessionTitle = vi.fn(async () => null)
    // Passing the same object twice could only prove the in-memory flag; an
    // eviction hands the next send a fresh session, which is the real case.
    let attempted = false
    const deps = {
      onConversationName: vi.fn(),
      readNamingState: () => ({ conversationName: null, namingAttempted: attempted }),
      markNamingAttempted: () => {
        attempted = true
      }
    }

    startClaudeConversationNaming(SESSION, sessionWith(generateSessionTitle), USER_TURN, deps)
    await settle()
    startClaudeConversationNaming(SESSION, sessionWith(generateSessionTitle), USER_TURN, deps)
    await settle()

    expect(generateSessionTitle).toHaveBeenCalledOnce()
  })

  it('reports nothing when the title request answers null', async () => {
    const onConversationName = vi.fn()

    startClaudeConversationNaming(SESSION, sessionWith(vi.fn(async () => null)), USER_TURN, {
      onConversationName
    })
    await settle()

    expect(onConversationName).not.toHaveBeenCalled()
  })

  it('keeps a failed title request off the turn', async () => {
    const onConversationName = vi.fn()
    const generateSessionTitle = vi.fn(async () => {
      throw new Error('claude generate_session_title request timed out')
    })

    expect(() =>
      startClaudeConversationNaming(SESSION, sessionWith(generateSessionTitle), USER_TURN, {
        onConversationName
      })
    ).not.toThrow()
    await settle()

    expect(onConversationName).not.toHaveBeenCalled()
  })

  it('does nothing when the submission carries no text to title', async () => {
    const generateSessionTitle = vi.fn(async () => 'x')

    startClaudeConversationNaming(
      SESSION,
      sessionWith(generateSessionTitle),
      { kind: 'message', role: 'user', blocks: [] } as unknown as AgentJournalMessageItem,
      { onConversationName: vi.fn() }
    )
    await settle()

    expect(generateSessionTitle).not.toHaveBeenCalled()
  })
})

describe('startClaudeConversationNaming robustness', () => {
  it('never fails the send when the title request throws synchronously', async () => {
    const onConversationName = vi.fn()
    // The control surface always exposes the method, so this shape is one the
    // types forbid — it stands in for any synchronous throw on the send path,
    // which is what actually turned a delivered message into a reported failure.
    const session = { namingAttempted: false, connection: {} } as unknown as ClaudeSession

    expect(() =>
      startClaudeConversationNaming(SESSION, session, USER_TURN, { onConversationName })
    ).not.toThrow()
    await settle()

    expect(onConversationName).not.toHaveBeenCalled()
  })
})

describe('startClaudeConversationNaming across re-acquisitions', () => {
  it('does not retitle a conversation the record already names', async () => {
    const generateSessionTitle = vi.fn(async () => 'A second, different title')
    // Claude rebuilds its session on every acquisition, so this fresh object is
    // exactly what an evict-then-reacquire hands the next send.
    const reacquired = sessionWith(generateSessionTitle)

    startClaudeConversationNaming(SESSION, reacquired, USER_TURN, {
      onConversationName: vi.fn(),
      readNamingState: () => ({ conversationName: 'Lease probe flake', namingAttempted: true })
    })
    await settle()

    expect(generateSessionTitle).not.toHaveBeenCalled()
  })

  it('still names a conversation the record has never named', async () => {
    const generateSessionTitle = vi.fn(async () => 'Lease probe flake')
    const onConversationName = vi.fn()

    startClaudeConversationNaming(SESSION, sessionWith(generateSessionTitle), USER_TURN, {
      onConversationName,
      readNamingState: () => ({ conversationName: null, namingAttempted: false })
    })
    await settle()

    expect(onConversationName).toHaveBeenCalledExactlyOnceWith(SESSION, 'Lease probe flake')
  })
})
