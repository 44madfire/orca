import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readClaudeTranscriptConversationName,
  reportPersistedClaudeConversationName
} from './claude-transcript-conversation-name'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-title-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function transcript(lines: readonly unknown[]): Promise<string> {
  const path = join(root, 'session-1.jsonl')
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8')
  return path
}

describe('readClaudeTranscriptConversationName', () => {
  it('reads the generated title Claude persisted', async () => {
    const path = await transcript([
      { type: 'user', sessionId: 'session-1' },
      { type: 'ai-title', aiTitle: 'Lease probe flake', sessionId: 'session-1' }
    ])

    await expect(readClaudeTranscriptConversationName(path)).resolves.toBe('Lease probe flake')
  })

  it('takes the latest generated title when Claude revised it', async () => {
    const path = await transcript([
      { type: 'ai-title', aiTitle: 'First guess', sessionId: 'session-1' },
      { type: 'ai-title', aiTitle: 'Lease probe flake', sessionId: 'session-1' }
    ])

    await expect(readClaudeTranscriptConversationName(path)).resolves.toBe('Lease probe flake')
  })

  it('prefers a name the user set over the generated one', async () => {
    const path = await transcript([
      { type: 'ai-title', aiTitle: 'Lease probe flake', sessionId: 'session-1' },
      { type: 'custom-title', customTitle: 'My own name', sessionId: 'session-1' }
    ])

    await expect(readClaudeTranscriptConversationName(path)).resolves.toBe('My own name')
  })

  it('reports null for a transcript that carries no name', async () => {
    const path = await transcript([{ type: 'user', sessionId: 'session-1' }])

    await expect(readClaudeTranscriptConversationName(path)).resolves.toBeNull()
  })
})

describe('reportPersistedClaudeConversationName', () => {
  const session = { providerSessionId: 'provider-1', claudeConfigDir: '/home/dev/.claude' }

  it('hands on the name the transcript held', async () => {
    const onConversationName = vi.fn()
    const readTranscriptConversationName = vi.fn(async () => 'Lease probe flake')

    reportPersistedClaudeConversationName('session-1', session, {
      readTranscriptConversationName,
      onConversationName
    })
    await vi.waitFor(() => expect(onConversationName).toHaveBeenCalled())

    // Asserted by shape, not against `session`: finding a name marks that object
    // as already named, so comparing to it would compare with the mutation.
    expect(readTranscriptConversationName).toHaveBeenCalledWith({
      providerSessionId: 'provider-1',
      claudeConfigDir: '/home/dev/.claude'
    })
    expect(onConversationName).toHaveBeenCalledExactlyOnceWith('session-1', 'Lease probe flake')
  })

  it('reports nothing when the transcript holds no name', async () => {
    const onConversationName = vi.fn()
    const readTranscriptConversationName = vi.fn(async () => null)

    reportPersistedClaudeConversationName('session-1', session, {
      readTranscriptConversationName,
      onConversationName
    })
    await vi.waitFor(() => expect(readTranscriptConversationName).toHaveBeenCalled())

    expect(onConversationName).not.toHaveBeenCalled()
  })

  it('swallows an unreadable transcript rather than failing the acquisition', async () => {
    const onConversationName = vi.fn()
    const readTranscriptConversationName = vi.fn(async () => {
      throw new Error('ENOENT')
    })

    expect(() =>
      reportPersistedClaudeConversationName('session-1', session, {
        readTranscriptConversationName,
        onConversationName
      })
    ).not.toThrow()
    await vi.waitFor(() => expect(readTranscriptConversationName).toHaveBeenCalled())

    expect(onConversationName).not.toHaveBeenCalled()
  })

  it('marks the session named, so nothing generates a second title for it', async () => {
    const live = { ...session, namingAttempted: false }

    reportPersistedClaudeConversationName('session-1', live, {
      readTranscriptConversationName: vi.fn(async () => 'Lease probe flake'),
      onConversationName: vi.fn()
    })
    await vi.waitFor(() => expect(live.namingAttempted).toBe(true))
  })

  it('leaves the session generatable when the transcript holds no name', async () => {
    const live = { ...session, namingAttempted: false }
    const readTranscriptConversationName = vi.fn(async () => null)

    reportPersistedClaudeConversationName('session-1', live, {
      readTranscriptConversationName,
      onConversationName: vi.fn()
    })
    await vi.waitFor(() => expect(readTranscriptConversationName).toHaveBeenCalled())

    expect(live.namingAttempted).toBe(false)
  })

  it('does nothing for a session that is not live', async () => {
    const readTranscriptConversationName = vi.fn(async () => 'Lease probe flake')

    reportPersistedClaudeConversationName('session-1', undefined, {
      readTranscriptConversationName,
      onConversationName: vi.fn()
    })

    expect(readTranscriptConversationName).not.toHaveBeenCalled()
  })
})
