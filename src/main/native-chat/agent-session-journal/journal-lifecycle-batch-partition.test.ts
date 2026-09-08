import { expect, it } from 'vitest'
import { partitionJournalLifecycleMutations } from './journal-lifecycle-batch-partition'
import { createJournalReducerState } from './journal-reducer'
import {
  journalLifecycleBatchRowBuilder,
  type JournalLifecycleMutationInput
} from './journal-row-builders'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from './journal-row-schema'

it.each(['item', 'tombstone'] as const)(
  'partitions escaped text with %s timing at the writer byte limit',
  (kind) => {
    const state = createJournalReducerState('session', '00000000-0000-4000-8000-000000000000')
    const build = (mutations: JournalLifecycleMutationInput[], settlementId = 'completion') =>
      journalLifecycleBatchRowBuilder(() => state, settlementId, mutations, { fence: 1 })(1, 1000)
    const mutations: JournalLifecycleMutationInput[] = Array.from({ length: 16 }, (_, index) => ({
      kind: 'item',
      identity: { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: index },
      body: { kind: 'status', text: '' }
    }))
    if (kind === 'tombstone') {
      mutations.push(
        ...Array.from({ length: 16 }, (_, index): JournalLifecycleMutationInput => ({
          kind: 'tombstone',
          identity: {
            provider: 'codex',
            threadId: 'thread',
            turnId: 'turn',
            ordinal: 16 + index
          }
        }))
      )
    }
    const emptyBytes = Buffer.byteLength(JSON.stringify(build(mutations)), 'utf8') + 1
    const textLength = Math.floor(
      (MAX_JOURNAL_LIFECYCLE_BATCH_BYTES - emptyBytes - 1000) / (16 * 6)
    )
    for (const mutation of mutations) {
      if (mutation.kind === 'item') {
        mutation.body = { kind: 'status', text: '\u0000'.repeat(textLength) }
      }
    }
    expect(textLength).toBeLessThan(16384)
    expect(() => build(mutations)).not.toThrow()
    for (const mutation of mutations) {
      if (mutation.kind === kind) {
        mutation.turnTiming = {
          userItemId: 'codex:thread:turn:user',
          start: { at: 1000, source: 'host', clock: 'acquisition' },
          end: { at: 188000, source: 'host', clock: 'acquisition' }
        }
      }
    }
    expect(() => build(mutations)).toThrow('journal_lifecycle_batch_byte_bound_exceeded')
    const chunks = partitionJournalLifecycleMutations('completion', mutations)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flatMap((chunk) => chunk.mutations)).toEqual(mutations)
    for (const chunk of chunks) {
      expect(() => build(chunk.mutations, chunk.settlementId)).not.toThrow()
    }
  }
)
