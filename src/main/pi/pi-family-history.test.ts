// PIF-8 (#29): one structural history algorithm plus narrow provider-aware
// entry normalization for Pi and OMP. Pure builder/translator tests: no child,
// no network, no journal.

import { describe, expect, it } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  extractActiveChainAfterAnchor,
  extractPiFamilyEntryText,
  piFamilyUserEntryFingerprint,
  translatePiFamilyBranchToHistory
} from './pi-family-history'
import { buildPiFamilyHistoryWindow } from './pi-family-history-window'

function piMessage(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] }
  }
}

function piRecord(id: string, parentId: string | null, type: string) {
  return { type, id, parentId, timestamp: '2026-01-01T00:00:00.000Z' }
}

// Linear Pi conversation A B C with an abandoned sibling X off B; D E extend the tip.
function piEntries() {
  return [
    piMessage('a', null, 'user', 'alpha'),
    piMessage('b', 'a', 'assistant', 'beta'),
    piMessage('c', 'b', 'user', 'gamma'),
    piMessage('x', 'b', 'user', 'abandoned'),
    piMessage('d', 'c', 'assistant', 'delta'),
    piMessage('e', 'd', 'user', 'epsilon')
  ]
}

// OMP-native shapes: top-level role/text plus state/audit records the walk passes through.
function ompEntries() {
  return [
    { type: 'omp_message', id: 'oa', parentId: null, role: 'user', text: 'alpha' },
    { type: 'omp_model_usage', id: 'ou', parentId: 'oa', model: 'm', tokens: 3 },
    { type: 'omp_message', id: 'ob', parentId: 'ou', role: 'assistant', text: 'beta' },
    { type: 'omp_state', id: 'os', parentId: 'ob', snapshot: { turn: 1 } },
    { type: 'omp_message', id: 'oc', parentId: 'os', role: 'user', text: 'gamma' },
    { type: 'omp_message', id: 'ox', parentId: 'ob', role: 'user', text: 'abandoned' }
  ]
}

describe('extractPiFamilyEntryText', () => {
  it('reads Pi content blocks and OMP top-level text without the exact union', () => {
    expect(extractPiFamilyEntryText(piMessage('a', null, 'user', 'alpha'))).toBe('alpha')
    expect(
      extractPiFamilyEntryText({
        type: 'omp_message',
        id: 'o',
        parentId: null,
        role: 'user',
        text: 'hi'
      })
    ).toBe('hi')
    expect(
      extractPiFamilyEntryText({ type: 'message', id: 's', parentId: null, message: 'flat' })
    ).toBe('flat')
  })

  it('returns null for image-only, tool-only, and state records', () => {
    const imageOnly = {
      type: 'message',
      id: 'i',
      parentId: null,
      message: { role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }
    }
    expect(extractPiFamilyEntryText(imageOnly)).toBe(null)
    expect(extractPiFamilyEntryText({ type: 'omp_state', id: 's', parentId: null })).toBe(null)
    expect(extractPiFamilyEntryText(null)).toBe(null)
  })
})

describe('translatePiFamilyBranchToHistory', () => {
  it('keeps Pi verbatim mapping and skips non-message records', () => {
    const rows = translatePiFamilyBranchToHistory(
      [
        piMessage('a', null, 'user', 'alpha'),
        piRecord('m', 'a', 'model_change'),
        piMessage('b', 'm', 'assistant', 'beta')
      ],
      'pi'
    )
    expect(rows.map((row) => [row.id, row.role, row.text])).toEqual([
      ['a', 'user', 'alpha'],
      ['b', 'assistant', 'beta']
    ])
  })

  it('tolerates OMP-native variants and passes through state records for chain continuity', () => {
    const rows = translatePiFamilyBranchToHistory(
      [
        { type: 'omp_message', id: 'oa', parentId: null, role: 'user', text: 'alpha' },
        { type: 'omp_summary', id: 'os', parentId: 'oa', text: 'compressed' },
        { type: 'omp_message', id: 'ob', parentId: 'os', role: 'assistant', text: 'beta' },
        { type: 'omp_audit', id: 'au', parentId: 'ob', action: 'x' }
      ],
      'omp'
    )
    expect(rows.map((row) => [row.id, row.role])).toEqual([
      ['oa', 'user'],
      ['ob', 'assistant']
    ])
  })
})

function chainIds(chain: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const entry of chain) {
    if (entry && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string') {
      ids.push(entry.id)
    }
  }
  return ids
}

describe('extractActiveChainAfterAnchor', () => {
  it('walks strictly after the anchor on full reads and excludes siblings', () => {
    const walked = extractActiveChainAfterAnchor({ entries: piEntries(), leafId: 'e', anchor: 'b' })
    expect(walked).toEqual({ ok: true, chain: expect.any(Array) })
    if (walked.ok) {
      expect(chainIds(walked.chain)).toEqual(['c', 'd', 'e'])
    }
  })

  it('works on since-windows that never contain the anchor', () => {
    const append = piEntries().filter(
      (entry) => entry.id === 'c' || entry.id === 'd' || entry.id === 'e'
    )
    const walked = extractActiveChainAfterAnchor({ entries: append, leafId: 'e', anchor: 'b' })
    expect(walked.ok).toBe(true)
    if (walked.ok) {
      expect(chainIds(walked.chain)).toEqual(['c', 'd', 'e'])
    }
  })

  it('fails closed on unknown leaves, broken chains, and off-branch anchors', () => {
    expect(
      extractActiveChainAfterAnchor({ entries: piEntries(), leafId: 'missing', anchor: 'b' })
    ).toMatchObject({ ok: false, code: 'PI_HISTORY_LEAF_MISSING' })
    // Anchor x lives on the abandoned sibling: not an ancestor of the tip.
    expect(
      extractActiveChainAfterAnchor({ entries: piEntries(), leafId: 'e', anchor: 'x' })
    ).toMatchObject({
      ok: false,
      code: 'PI_HISTORY_ANCHOR_UNKNOWN'
    })
    const broken = piEntries().filter((entry) => entry.id !== 'd')
    expect(
      extractActiveChainAfterAnchor({ entries: broken, leafId: 'e', anchor: 'b' })
    ).toMatchObject({
      ok: false,
      code: 'PI_HISTORY_CHAIN_BROKEN'
    })
  })
})

describe('buildPiFamilyHistoryWindow', () => {
  it('returns strictly-after user evidence with stable identity for Pi', () => {
    const built = buildPiFamilyHistoryWindow({
      provider: 'pi',
      providerSessionId: 'pi-ses-1',
      orcaSessionId: 'orca-1',
      anchorLeafId: 'b',
      entries: piEntries(),
      leafId: 'e'
    })
    expect(built.ok).toBe(true)
    if (!built.ok) {
      return
    }
    expect(built.leafId).toBe('e')
    expect(built.window.boundaryConsistent).toBe(true)
    expect(built.window.items.map((item) => item.providerItemId)).toEqual(['c', 'e'])
    for (const item of built.window.items) {
      expect(item.clientMessageId).toBe(null)
      expect(item.identity).toEqual({
        provider: 'legacy',
        agent: 'pi',
        sessionId: 'pi-ses-1',
        recordId: item.providerItemId
      })
    }
    // Fingerprints equal the send path over the same body, so the GENERIC
    // reconciler matches by equality rather than provider-specific guessing.
    expect(built.window.items[0]?.payloadFingerprint).toBe(
      computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'orca-1',
        fields: {
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'gamma' }] }
        }
      })
    )
    expect(piFamilyUserEntryFingerprint('orca-1', 'gamma')).toBe(
      built.window.items[0]?.payloadFingerprint
    )
  })

  it('builds the same window from a since-append and from OMP-native entries', () => {
    const append = piEntries().filter(
      (entry) => entry.id !== 'a' && entry.id !== 'b' && entry.id !== 'x'
    )
    const since = buildPiFamilyHistoryWindow({
      provider: 'pi',
      providerSessionId: 'pi-ses-1',
      orcaSessionId: 'orca-1',
      anchorLeafId: 'b',
      entries: append,
      leafId: 'e'
    })
    expect(since.ok).toBe(true)
    if (since.ok) {
      expect(since.window.items.map((item) => item.providerItemId)).toEqual(['c', 'e'])
    }
    const omp = buildPiFamilyHistoryWindow({
      provider: 'omp',
      providerSessionId: 'omp-ses-1',
      orcaSessionId: 'orca-2',
      anchorLeafId: 'ob',
      entries: ompEntries(),
      leafId: 'oc'
    })
    expect(omp.ok).toBe(true)
    if (omp.ok) {
      // The state/audit records keep chain positions but never become evidence.
      expect(omp.window.items.map((item) => item.providerItemId)).toEqual(['oc'])
      expect(omp.window.items[0]?.identity).toMatchObject({ agent: 'omp', sessionId: 'omp-ses-1' })
    }
  })

  it('fails closed with an inconsistent boundary on unproven starts', () => {
    const base = {
      provider: 'pi' as const,
      providerSessionId: 'pi-ses-1',
      orcaSessionId: 'orca-1',
      entries: piEntries(),
      leafId: 'e'
    }
    for (const anchorLeafId of [undefined, 'missing-anchor', 'x']) {
      const built = buildPiFamilyHistoryWindow({ ...base, anchorLeafId })
      expect(built.ok).toBe(false)
      if (!built.ok) {
        expect(built.window).toMatchObject({ items: [], boundaryConsistent: false })
        expect(built.leafId).toBe('e')
      }
    }
    // Missing cursor with history fails closed even when the leaf matches nothing.
    const missing = buildPiFamilyHistoryWindow({ ...base, anchorLeafId: null })
    expect(missing.ok).toBe(false)
  })

  it('treats a proven-empty session as evidence and a moved tip as unproven', () => {
    const emptyTip = buildPiFamilyHistoryWindow({
      provider: 'pi',
      providerSessionId: 'pi-ses-1',
      orcaSessionId: 'orca-1',
      anchorLeafId: 'e',
      entries: [],
      leafId: 'e'
    })
    expect(emptyTip).toMatchObject({ ok: true, leafId: 'e' })
    if (emptyTip.ok) {
      expect(emptyTip.window).toMatchObject({ items: [], boundaryConsistent: true })
    }
    const fresh = buildPiFamilyHistoryWindow({
      provider: 'pi',
      providerSessionId: 'pi-ses-1',
      orcaSessionId: 'orca-1',
      anchorLeafId: null,
      entries: [],
      leafId: ''
    })
    expect(fresh.ok).toBe(true)
    const moved = buildPiFamilyHistoryWindow({
      provider: 'pi',
      providerSessionId: 'pi-ses-1',
      orcaSessionId: 'orca-1',
      anchorLeafId: 'e',
      entries: piEntries(),
      leafId: 'e'
    })
    expect(moved.ok).toBe(false)
  })
})
