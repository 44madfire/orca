// Pi-family dispatch admission + history-backed settlement unit tests (PIF-4, #25).
//
// Pure helpers only (no provider child): prompt translation, OMP
// `prompt_result` normalization, narrow entry normalization, cursor-sliced
// candidate matching, the ephemeral pending tracker, and the settlement
// orchestration against fake history. Scripted-child settlement lives in
// `pi-family-dispatch-settlement.test.ts`.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../shared/agent-session-journal-types'
import {
  findPiFamilySettlingCandidates,
  interpretOmpPromptResult,
  normalizePiFamilyHistoryEntry,
  piFamilySettlementIdentity,
  PiFamilyDispatchTracker,
  sanitizePiFamilyPromptError,
  settlePiFamilyPendingDispatch,
  translatePiFamilyPromptBody
} from './pi-family-dispatch'

const DIRS: string[] = []
afterEach(() => {
  for (const dir of DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort temp cleanup only.
    }
  }
})

function textBody(
  text: string,
  extraBlocks: AgentJournalMessageItem['blocks'] = []
): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }, ...extraBlocks]
  }
}

function piMessage(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] }
  }
}

describe('translatePiFamilyPromptBody', () => {
  it('maps plain text exactly', async () => {
    const content = await translatePiFamilyPromptBody(textBody('hello world'))
    expect(content.text).toBe('hello world')
    expect(content.images).toBeUndefined()
  })

  it('joins text blocks exactly like the shared extraction path', async () => {
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' }
      ]
    }
    await expect(translatePiFamilyPromptBody(body)).resolves.toMatchObject({
      text: 'first\nsecond'
    })
  })

  it('preserves supported image MIME and base64 bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-family-prompt-'))
    DIRS.push(dir)
    const png = join(dir, 'shot.png')
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    writeFileSync(png, bytes)
    const content = await translatePiFamilyPromptBody(
      textBody('look', [{ type: 'image-ref', path: png }])
    )
    expect(content.images).toHaveLength(1)
    expect(content.images?.[0]).toEqual({
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: 'image/png'
    })
  })

  it('rejects remote URLs before any write without leaking the URL', async () => {
    const url = 'https://example.invalid/secret-image.png?token=abc123'
    await expect(
      translatePiFamilyPromptBody(textBody('look', [{ type: 'image-ref', url }]))
    ).rejects.toThrow('Pi image URLs are unsupported')
    try {
      await translatePiFamilyPromptBody(textBody('look', [{ type: 'image-ref', url }]))
      expect.unreachable()
    } catch (error) {
      expect(sanitizePiFamilyPromptError(error)).not.toContain('example.invalid')
      expect(sanitizePiFamilyPromptError(error)).not.toContain('abc123')
    }
  })

  it('rejects missing files without leaking the path or prompt text', async () => {
    const secret = 'super secret prompt text 12345'
    const missing = join(tmpdir(), 'pi-family-absent-image.png')
    let failure: unknown
    try {
      await translatePiFamilyPromptBody(textBody(secret, [{ type: 'image-ref', path: missing }]))
      expect.unreachable()
    } catch (error) {
      failure = error
    }
    const reason = sanitizePiFamilyPromptError(failure)
    expect(reason).not.toContain('pi-family-absent-image')
    expect(reason).not.toContain(secret)
  })

  it('rejects unsupported image types without prompt bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-family-prompt-'))
    DIRS.push(dir)
    const bmp = join(dir, 'shot.bmp')
    writeFileSync(bmp, Buffer.from([1, 2, 3]))
    await expect(
      translatePiFamilyPromptBody(textBody('pixel secret', [{ type: 'image-ref', path: bmp }]))
    ).rejects.toThrow('Pi does not support the image type')
  })

  it('leaves empty text to the pre-write validation downstream (image-only turns stay valid)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-family-prompt-'))
    DIRS.push(dir)
    const png = join(dir, 'shot.png')
    writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'image-ref', path: png }]
    }
    const content = await translatePiFamilyPromptBody(body)
    expect(content.text).toBe('')
    expect(content.images).toHaveLength(1)
  })
})

describe('interpretOmpPromptResult', () => {
  it('continues the normal turn on agentInvoked:true', () => {
    expect(interpretOmpPromptResult({ type: 'prompt_result', id: 'r1', agentInvoked: true })).toBe(
      'agent-turn'
    )
  })

  it('retires the local prompt on agentInvoked:false', () => {
    expect(interpretOmpPromptResult({ type: 'prompt_result', id: 'r1', agentInvoked: false })).toBe(
      'local-only'
    )
  })

  it('fabricates nothing when agentInvoked is missing or untyped', () => {
    expect(interpretOmpPromptResult({ type: 'prompt_result', id: 'r1' })).toBe('ignore')
    expect(interpretOmpPromptResult({ type: 'prompt_result', agentInvoked: 'yes' })).toBe('ignore')
    expect(interpretOmpPromptResult({ type: 'prompt_result', agentInvoked: null })).toBe('ignore')
  })

  it('ignores non-prompt_result records', () => {
    expect(interpretOmpPromptResult({ type: 'agent_end', isTerminal: true })).toBe('ignore')
    expect(interpretOmpPromptResult({ type: 'response' })).toBe('ignore')
  })
})

describe('normalizePiFamilyHistoryEntry', () => {
  it('reads Pi-shaped message entries', () => {
    expect(normalizePiFamilyHistoryEntry(piMessage('e1', null, 'user', 'hi'))).toEqual({
      id: 'e1',
      parentId: null,
      type: 'message',
      role: 'user'
    })
  })

  it('reads OMP-native entries without Pi decoding', () => {
    expect(
      normalizePiFamilyHistoryEntry({
        type: 'omp_message',
        id: 'o1',
        parentId: 'o0',
        role: 'user',
        text: 'hi'
      })
    ).toEqual({ id: 'o1', parentId: 'o0', type: 'omp_message', role: 'user' })
    expect(
      normalizePiFamilyHistoryEntry({ type: 'omp_summary', id: 'o2', parentId: 'o1' })
    ).toEqual({
      id: 'o2',
      parentId: 'o1',
      type: 'omp_summary',
      role: null
    })
  })

  it('drops entries without a stable id or type', () => {
    expect(normalizePiFamilyHistoryEntry(null)).toBeNull()
    expect(normalizePiFamilyHistoryEntry('e1')).toBeNull()
    expect(normalizePiFamilyHistoryEntry({ type: 'message', parentId: null })).toBeNull()
    expect(normalizePiFamilyHistoryEntry({ id: 'e1', parentId: null })).toBeNull()
    expect(normalizePiFamilyHistoryEntry({ id: '', type: 'message' })).toBeNull()
  })
})

describe('findPiFamilySettlingCandidates', () => {
  const seed = [
    piMessage('e1', null, 'user', 'first'),
    piMessage('e2', 'e1', 'assistant', 'second')
  ]

  it('returns only user entries committed after the cursor', () => {
    const fresh = [
      piMessage('e3', 'e2', 'user', 'third'),
      piMessage('e4', 'e3', 'assistant', 'fourth')
    ]
    const match = findPiFamilySettlingCandidates({
      entries: [...seed, ...fresh],
      preDispatchLeafId: 'e2'
    })
    expect(match).toEqual({ ok: true, candidates: [expect.objectContaining({ id: 'e3' })] })
  })

  it('treats a null cursor as a fresh session (every entry is new)', () => {
    const match = findPiFamilySettlingCandidates({ entries: seed, preDispatchLeafId: null })
    expect(match).toEqual({ ok: true, candidates: [expect.objectContaining({ id: 'e1' })] })
  })

  it('fails closed when the cursor is gone (fork/truncation proves nothing)', () => {
    expect(findPiFamilySettlingCandidates({ entries: seed, preDispatchLeafId: 'absent' })).toEqual({
      ok: false,
      reason: 'cursor-unknown'
    })
  })

  it('ignores non-user and malformed entries without failing', () => {
    const entries = [
      piMessage('e3', 'e2', 'assistant', 'reply'),
      { type: 'message', id: 'e4', parentId: 'e3', message: { role: 'toolResult', content: [] } },
      { type: 'summary', id: 'e5', parentId: 'e4' },
      null,
      { id: 'broken' }
    ]
    const match = findPiFamilySettlingCandidates({ entries, preDispatchLeafId: null })
    expect(match).toEqual({ ok: true, candidates: [] })
  })
})

describe('PiFamilyDispatchTracker', () => {
  it('arms, claims, and drains exactly once', () => {
    const tracker = new PiFamilyDispatchTracker()
    tracker.arm('s1', {
      clientMessageId: 'c1',
      provider: 'pi',
      generation: 'g1',
      preDispatchLeafId: null
    })
    expect(tracker.pendingFor('s1')).toHaveLength(1)
    expect(tracker.claim('s1', 'c1', 'g1')).toMatchObject({ clientMessageId: 'c1' })
    expect(tracker.claim('s1', 'c1', 'g1')).toBeNull()
    expect(tracker.pendingFor('s1')).toHaveLength(0)
  })

  it('keeps the first cursor when the same send is re-armed', () => {
    const tracker = new PiFamilyDispatchTracker()
    tracker.arm('s1', {
      clientMessageId: 'c1',
      provider: 'pi',
      generation: 'g1',
      preDispatchLeafId: 'e1'
    })
    tracker.arm('s1', {
      clientMessageId: 'c1',
      provider: 'pi',
      generation: 'g1',
      preDispatchLeafId: 'e9'
    })
    expect(tracker.pendingFor('s1')).toEqual([
      { clientMessageId: 'c1', provider: 'pi', generation: 'g1', preDispatchLeafId: 'e1' }
    ])
  })

  it('refuses cross-generation claims and drops sessions wholesale', () => {
    const tracker = new PiFamilyDispatchTracker()
    tracker.arm('s1', {
      clientMessageId: 'c1',
      provider: 'omp',
      generation: 'g1',
      preDispatchLeafId: null
    })
    expect(tracker.claim('s1', 'c1', 'g2')).toBeNull()
    expect(tracker.pendingFor('s1')).toHaveLength(1)
    tracker.retainOnly('s1', [])
    expect(tracker.pendingFor('s1')).toHaveLength(0)
    tracker.arm('s1', {
      clientMessageId: 'c1',
      provider: 'omp',
      generation: 'g1',
      preDispatchLeafId: null
    })
    tracker.dropSession('s1')
    expect(tracker.pendingFor('s1')).toHaveLength(0)
  })
})

describe('settlePiFamilyPendingDispatch', () => {
  const session = {
    orcaSessionId: 'ses-1',
    provider: 'pi' as const,
    piSessionId: 'pi-1',
    generation: 'g1'
  }

  function settled() {
    const calls: {
      sessionId: string
      clientMessageId: string
      providerIdentity: AgentJournalItemIdentity
    }[] = []
    return {
      calls,
      onSettled: (input: {
        sessionId: string
        clientMessageId: string
        providerIdentity: AgentJournalItemIdentity
      }) => {
        calls.push(input)
      }
    }
  }

  it('settles one pending against one new user entry with stable provider identity', async () => {
    const tracker = new PiFamilyDispatchTracker()
    tracker.arm('ses-1', {
      clientMessageId: 'c1',
      provider: 'pi',
      generation: 'g1',
      preDispatchLeafId: 'e2'
    })
    const sink = settled()
    const settledOk = await settlePiFamilyPendingDispatch({
      session,
      tracker,
      readEntries: async () => ({
        entries: [
          piMessage('e1', null, 'user', 'old'),
          piMessage('e2', 'e1', 'assistant', 'old reply'),
          piMessage('e3', 'e2', 'user', 'new')
        ],
        leafId: 'e3'
      }),
      onSettled: sink.onSettled
    })
    expect(settledOk).toBe(true)
    expect(sink.calls).toHaveLength(1)
    // Stable provider-native identity: the entry id, never the client message id.
    expect(sink.calls[0]).toEqual({
      sessionId: 'ses-1',
      clientMessageId: 'c1',
      providerIdentity: { provider: 'legacy', agent: 'pi', sessionId: 'pi-1', recordId: 'e3' }
    })
    expect(tracker.pendingFor('ses-1')).toHaveLength(0)
  })

  it('never reads history when nothing is pending', async () => {
    const tracker = new PiFamilyDispatchTracker()
    const sink = settled()
    let reads = 0
    const settledOk = await settlePiFamilyPendingDispatch({
      session,
      tracker,
      readEntries: async () => {
        reads += 1
        return { entries: [], leafId: 'e0' }
      },
      onSettled: sink.onSettled
    })
    expect(settledOk).toBe(false)
    expect(reads).toBe(0)
    expect(sink.calls).toHaveLength(0)
  })

  it('retains pending when zero or several user entries match (no invented identity)', async () => {
    for (const entries of [
      [piMessage('e3', 'e2', 'assistant', 'reply')],
      [piMessage('e3', 'e2', 'user', 'one'), piMessage('e4', 'e3', 'user', 'two')]
    ]) {
      const tracker = new PiFamilyDispatchTracker()
      tracker.arm('ses-1', {
        clientMessageId: 'c1',
        provider: 'pi',
        generation: 'g1',
        preDispatchLeafId: 'e2'
      })
      const sink = settled()
      const settledOk = await settlePiFamilyPendingDispatch({
        session,
        tracker,
        readEntries: async () => ({ entries, leafId: 'e9' }),
        onSettled: sink.onSettled
      })
      expect(settledOk).toBe(false)
      expect(sink.calls).toHaveLength(0)
      expect(tracker.pendingFor('ses-1')).toHaveLength(1)
    }
  })

  it('retains pending on cursor loss, history failure, and missing settlement sink', async () => {
    const tracker = new PiFamilyDispatchTracker()
    tracker.arm('ses-1', {
      clientMessageId: 'c1',
      provider: 'pi',
      generation: 'g1',
      preDispatchLeafId: 'gone'
    })
    const sink = settled()
    await expect(
      settlePiFamilyPendingDispatch({
        session,
        tracker,
        readEntries: async () => ({
          entries: [piMessage('e3', 'gone', 'user', 'new')],
          leafId: 'e3'
        }),
        onSettled: sink.onSettled
      })
    ).resolves.toBe(false)
    await expect(
      settlePiFamilyPendingDispatch({
        session,
        tracker,
        readEntries: async () => {
          throw new Error('pi-exited')
        },
        onSettled: sink.onSettled
      })
    ).resolves.toBe(false)
    tracker.arm('ses-1', {
      clientMessageId: 'c2',
      provider: 'pi',
      generation: 'g1',
      preDispatchLeafId: null
    })
    await expect(
      settlePiFamilyPendingDispatch({
        session: { ...session, generation: 'g1' },
        tracker,
        readEntries: async () => ({
          entries: [piMessage('e3', null, 'user', 'new')],
          leafId: 'e3'
        }),
        onSettled: undefined
      })
    ).resolves.toBe(false)
    expect(sink.calls).toHaveLength(0)
    expect(tracker.pendingFor('ses-1')).toHaveLength(2)
  })

  it('drops superseded generations without settling them', async () => {
    const tracker = new PiFamilyDispatchTracker()
    tracker.arm('ses-1', {
      clientMessageId: 'c-old',
      provider: 'pi',
      generation: 'g0',
      preDispatchLeafId: null
    })
    const sink = settled()
    const settledOk = await settlePiFamilyPendingDispatch({
      session: { ...session, generation: 'g1' },
      tracker,
      readEntries: async () => ({ entries: [piMessage('e3', null, 'user', 'new')], leafId: 'e3' }),
      onSettled: sink.onSettled
    })
    expect(settledOk).toBe(false)
    expect(sink.calls).toHaveLength(0)
    expect(tracker.pendingFor('ses-1')).toHaveLength(0)
  })

  it('is idempotent across repeated observations', async () => {
    const tracker = new PiFamilyDispatchTracker()
    tracker.arm('ses-1', {
      clientMessageId: 'c1',
      provider: 'pi',
      generation: 'g1',
      preDispatchLeafId: null
    })
    const sink = settled()
    const history = { entries: [piMessage('e3', null, 'user', 'new')], leafId: 'e3' }
    await expect(
      settlePiFamilyPendingDispatch({
        session,
        tracker,
        readEntries: async () => history,
        onSettled: sink.onSettled
      })
    ).resolves.toBe(true)
    await expect(
      settlePiFamilyPendingDispatch({
        session,
        tracker,
        readEntries: async () => history,
        onSettled: sink.onSettled
      })
    ).resolves.toBe(false)
    expect(sink.calls).toHaveLength(1)
  })

  it('loses a claim race without settling (a concurrent observer won)', async () => {
    const tracker = new PiFamilyDispatchTracker()
    tracker.arm('ses-1', {
      clientMessageId: 'c1',
      provider: 'pi',
      generation: 'g1',
      preDispatchLeafId: null
    })
    const sink = settled()
    const settledOk = await settlePiFamilyPendingDispatch({
      session,
      tracker,
      readEntries: async () => {
        expect(tracker.claim('ses-1', 'c1', 'g1')).not.toBeNull()
        return { entries: [piMessage('e3', null, 'user', 'new')], leafId: 'e3' }
      },
      onSettled: sink.onSettled
    })
    expect(settledOk).toBe(false)
    expect(sink.calls).toHaveLength(0)
  })
})

describe('piFamilySettlementIdentity', () => {
  it('carries the provider discriminant plus stable session/entry ids', () => {
    expect(
      piFamilySettlementIdentity({ provider: 'omp', providerSessionId: 'omp-1', entryId: 'o7' })
    ).toEqual({
      provider: 'legacy',
      agent: 'omp',
      sessionId: 'omp-1',
      recordId: 'o7'
    })
  })
})
