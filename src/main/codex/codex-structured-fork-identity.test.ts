import { describe, expect, it } from 'vitest'
import { assertCodexForkedIdentities } from './codex-structured-fork-identity'
const fork = {
  source: { provider: 'codex', threadId: 'parent' },
  throughId: 'selected',
  retainedItemIds: ['codex:parent:previous:0', 'codex:parent:selected:0', 'codex:parent:selected:1']
} as const

describe('Codex fork retained identity proof', () => {
  it('accepts provider-listed turns and ordinals retaining every copied identity', () => {
    expect(() =>
      assertCodexForkedIdentities('child', fork, [
        { provider: 'codex', threadId: 'child', turnId: 'previous', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'selected', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'selected', ordinal: 1 }
      ])
    ).not.toThrow()
  })
  it('refuses new provider turn IDs instead of publishing identities that duplicate on hydration', () => {
    expect(() =>
      assertCodexForkedIdentities('child', fork, [
        { provider: 'codex', threadId: 'child', turnId: 'new-previous', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'new-selected', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'new-selected', ordinal: 1 }
      ])
    ).toThrow('proof-mismatch')
  })
  it('refuses missing provider items even when the selected turn survives', () => {
    expect(() =>
      assertCodexForkedIdentities('child', fork, [
        { provider: 'codex', threadId: 'child', turnId: 'previous', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'selected', ordinal: 0 }
      ])
    ).toThrow('proof-mismatch')
  })
})
