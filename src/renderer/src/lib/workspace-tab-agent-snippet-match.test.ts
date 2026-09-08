import { afterEach, describe, expect, it, vi } from 'vitest'
import * as normalizedText from './palette-match/normalized-text'
import { preparePaletteTabQuery } from './palette-match/tab-match'
import type { AgentMetadata } from './workspace-tab-agent-metadata'
import { matchWorkspaceTabAgentSnippet } from './workspace-tab-agent-snippet-match'

function metadata(snippetCandidates: string[], textParts: string[] = []): AgentMetadata {
  return { paneKey: 'terminal:leaf', snippetCandidates, textParts, lastActivityAt: 1 }
}

function query(text: string) {
  const prepared = preparePaletteTabQuery(text)
  if (!prepared) {
    throw new Error(`Invalid test query: ${text}`)
  }
  return prepared
}

afterEach(() => vi.restoreAllMocks())

describe('workspace terminal agent snippet search', () => {
  it('folds each distinct Unicode prompt once across searches of accumulated history', () => {
    const histories = Array.from({ length: 10 }, (_, i) => `Task ${i}: İnvestigate terminal input`)
    const repeated = histories.flatMap((text) => [text, text])
    const entries = [metadata(repeated, [...repeated, 'codex', 'working'])]
    const firstQuery = query('missing')
    const secondQuery = query('absent')
    const normalize = vi.spyOn(normalizedText, 'normalizePaletteText')

    expect(matchWorkspaceTabAgentSnippet(entries, firstQuery)).toBeNull()
    expect(normalize).toHaveBeenCalledTimes(10)
    normalize.mockClear()
    expect(matchWorkspaceTabAgentSnippet(entries, secondQuery)).toBeNull()
    expect(normalize).not.toHaveBeenCalled()
  })

  it('normalizes later candidates only when earlier candidates fail', () => {
    const entries = [metadata(['First İnvestigation', 'Second İnvestigation'])]
    const firstQuery = query('first')
    const secondQuery = query('second')
    const normalize = vi.spyOn(normalizedText, 'normalizePaletteText')

    expect(matchWorkspaceTabAgentSnippet(entries, firstQuery)?.text).toBe('First İnvestigation')
    expect(normalize).toHaveBeenCalledTimes(1)
    normalize.mockClear()
    expect(matchWorkspaceTabAgentSnippet(entries, secondQuery)?.text).toBe('Second İnvestigation')
    expect(normalize).toHaveBeenCalledTimes(1)
  })

  it('preserves source, pane, and text priority across duplicate candidates', () => {
    const entries = [
      metadata(['unrelated', 'unrelated'], ['Earlier pane atlas provider']),
      metadata(['Later pane atlas task', 'Another atlas task'], ['unrelated'])
    ]
    expect(matchWorkspaceTabAgentSnippet(entries, query('atlas'))).toMatchObject({
      text: 'Later pane atlas task',
      ranges: [{ start: 11, end: 16 }]
    })
  })

  it('keeps provider-only text searchable after snippet candidates fail', () => {
    const entries = [metadata(['Terminal task'], ['Terminal task', 'session_id', 'sess-unique'])]
    expect(matchWorkspaceTabAgentSnippet(entries, query('sess-unique'))?.text).toBe('sess-unique')
  })

  it('keeps case expansion offsets and merged highlights stable across query edits', () => {
    const entries = [metadata(['İstanbul Terminal'])]
    expect(matchWorkspaceTabAgentSnippet(entries, query('terminal'))?.ranges).toEqual([
      { start: 9, end: 17 }
    ])
    expect(matchWorkspaceTabAgentSnippet(entries, query('İstanbul stan'))?.ranges).toEqual([
      { start: 0, end: 8 }
    ])
  })

  it('requires every token to occur in the same candidate', () => {
    const entries = [metadata(['Verify input', 'Inspect output'])]
    expect(matchWorkspaceTabAgentSnippet(entries, query('input output'))).toBeNull()
    expect(matchWorkspaceTabAgentSnippet(entries, query('verify input'))?.text).toBe('Verify input')
  })

  it('keeps the cheap path for offset-preserving text and rejects punctuation tokens', () => {
    const entries = [metadata(['Terminal --- output'])]
    const prepared = query('terminal ---')
    const normalize = vi.spyOn(normalizedText, 'normalizePaletteText')
    expect(matchWorkspaceTabAgentSnippet(entries, prepared)).toBeNull()
    expect(normalize).not.toHaveBeenCalled()
  })

  it('uses rebuilt metadata independently of the previous snapshot with the same pane id', () => {
    const previous = [metadata(['Previous atlas İnvestigation'])]
    const current = [metadata(['Current nebula İnvestigation'])]
    expect(matchWorkspaceTabAgentSnippet(previous, query('atlas'))?.text).toBe(
      'Previous atlas İnvestigation'
    )
    expect(matchWorkspaceTabAgentSnippet(current, query('atlas'))).toBeNull()
    expect(matchWorkspaceTabAgentSnippet(current, query('nebula'))?.text).toBe(
      'Current nebula İnvestigation'
    )
    expect(matchWorkspaceTabAgentSnippet(previous, query('nebula'))).toBeNull()
  })

  it('does not retain metadata after its palette entries are released', async () => {
    const gc = global.gc
    if (!gc) {
      throw new Error('This test requires --expose-gc')
    }
    function searchTransientEntries(): WeakRef<AgentMetadata[]> {
      const entries = [metadata(['Transient Terminal İnvestigation'])]
      matchWorkspaceTabAgentSnippet(entries, query('missing'))
      return new WeakRef(entries)
    }
    const reference = searchTransientEntries()
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      gc()
      if (!reference.deref()) {
        break
      }
    }
    expect(reference.deref()).toBeUndefined()
  })
})
