import { describe, expect, it } from 'vitest'
import { openSessionSearchIndexFile } from './session-search-staged-write-test-fixture'
import { SessionSearchTypoRepair } from './session-search-typo-repair'

describe('typo repair policy', () => {
  it.each([
    { input: 'coalesces', candidate: 'coalesced', copies: 2, exact: true, expected: null },
    { input: 'coalescs', candidate: 'coalesces', copies: 1, exact: false, expected: null },
    { input: 'coalescs', candidate: 'coalesces', copies: 2, exact: false, expected: 'coalesces' },
    { input: 'café', candidate: 'cafe', copies: 1, exact: false, expected: null },
    { input: 'car', candidate: 'cars', copies: 2, exact: false, expected: null },
    { input: 'calm', candidate: 'clam', copies: 2, exact: false, expected: null }
  ])(
    'repairs $input to $expected with $copies postings (exact=$exact)',
    async ({ input, candidate, copies, exact, expected }) => {
      const index = await openSessionSearchIndexFile('ss-typo-policy')
      try {
        const insert = index.db.prepare('INSERT INTO messages_fts(user_text) VALUES (?)')
        for (let i = 0; i < copies; i++) {
          insert.run(candidate)
        }
        if (exact) {
          insert.run(input)
        }
        expect(new SessionSearchTypoRepair(index.db).correct(input)).toBe(expected)
      } finally {
        await index.close()
      }
    }
  )
})
