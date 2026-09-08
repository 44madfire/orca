import { expect, it } from 'vitest'
import { projectSessionSearchResult } from './ai-vault-search-projection'
import type { AiVaultSearchResult, AiVaultSearchHit } from './ai-vault-search-types'

const hit: AiVaultSearchHit = {
  agent: 'codex',
  sessionId: 'same-id',
  filePath: '/same/file.jsonl',
  codexHome: null,
  title: 'title',
  cwd: '/same',
  branch: null,
  updatedAt: null,
  messageCount: 1,
  resumeCommand: 'codex resume same-id',
  score: 1,
  evidence: { role: 'user', timestamp: null, snippet: '🦀'.repeat(5000) }
}
const result = (hits: AiVaultSearchHit[]): AiVaultSearchResult => ({
  hits,
  route: 'phrase',
  durationMs: 1,
  coverage: {
    sessionsIndexed: hits.length,
    messagesIndexed: hits.length,
    providers: [],
    backfill: 'complete',
    filesPending: 0,
    lastIndexedAt: null
  }
})

it('bounds snippets on UTF-8 boundaries while preserving paths and session identity', () => {
  const projected = projectSessionSearchResult(result([hit]))
  expect(Buffer.byteLength(projected.hits[0]!.evidence.snippet)).toBe(4096)
  expect(projected.hits[0]!.evidence.snippet).not.toContain('\uFFFD')
  expect(projected.hits[0]).toMatchObject({ sessionId: hit.sessionId, filePath: hit.filePath })
  expect(projected.truncatedSnippets).toBe(1)
})

it('omits oversized identities and caps serialized response size with explicit accounting', () => {
  const projected = projectSessionSearchResult(
    result([
      { ...hit, sessionId: 'x'.repeat(40000) },
      ...Array.from({ length: 100 }, () => ({ ...hit, title: 'x'.repeat(32000) }))
    ])
  )
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(512 * 1024)
  expect(projected.omittedHits! + projected.hits.length).toBe(101)
})
