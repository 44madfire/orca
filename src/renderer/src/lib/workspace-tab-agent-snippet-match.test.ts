import { describe, expect, it } from 'vitest'
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

describe('workspace terminal agent snippet search', () => {
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

  it('matches Turkish dotted I from either casing and keeps literal source offsets', () => {
    const entries = [metadata(['İstanbul Terminal'])]
    for (const text of ['istanbul', 'İstanbul', 'ISTANBUL']) {
      expect(matchWorkspaceTabAgentSnippet(entries, query(text))).toMatchObject({
        text: 'İstanbul Terminal',
        ranges: [{ start: 0, end: 8 }]
      })
    }
    expect('İstanbul Terminal'.slice(0, 8)).toBe('İstanbul')
  })

  it('keeps highlight offsets and merged ranges stable across query edits', () => {
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

  it('rejects punctuation-only tokens before scanning candidates', () => {
    const entries = [metadata(['Terminal --- output'])]
    expect(matchWorkspaceTabAgentSnippet(entries, query('terminal ---'))).toBeNull()
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

  it('reflects in-place candidate edits on the same metadata array', () => {
    const entries = [metadata(['Original atlas prompt İnvestigation'])]
    expect(matchWorkspaceTabAgentSnippet(entries, query('atlas'))).not.toBeNull()
    entries[0].snippetCandidates[0] = 'Replaced nebula prompt İnvestigation'
    expect(matchWorkspaceTabAgentSnippet(entries, query('atlas'))).toBeNull()
    expect(matchWorkspaceTabAgentSnippet(entries, query('nebula'))?.text).toBe(
      'Replaced nebula prompt İnvestigation'
    )
  })

  it('folds case for every script without shifting highlight offsets', () => {
    const cases: [string, string, string][] = [
      ['ЗАПУСТИТЬ ТЕРМИНАЛ СЕЙЧАС', 'терминал', 'ТЕРМИНАЛ'],
      ['ΕΛΛΗΝΙΚΆ ΚΕΊΜΕΝΟ', 'κείμενο', 'ΚΕΊΜΕΝΟ'],
      ['ÉCRIRE UN TEST ÀÉÎÔÜ', 'àéîôü', 'ÀÉÎÔÜ'],
      ['终端任务调查报告', '终端任务', '终端任务'],
      ['🚀 emoji terminal 🎉', 'terminal', 'terminal'],
      ['ＦＵＬＬＷＩＤＴＨ ＴＥＸＴ', 'ｔｅｘｔ', 'ＴＥＸＴ'],
      ['İstanbul İŞLEM', 'işlem', 'İŞLEM']
    ]
    for (const [text, queryText, expected] of cases) {
      const match = matchWorkspaceTabAgentSnippet([metadata([text])], query(queryText))
      expect(match).not.toBeNull()
      const range = (match as NonNullable<typeof match>).ranges[0]
      expect(text.slice(range.start, range.end)).toBe(expected)
    }
  })
})
