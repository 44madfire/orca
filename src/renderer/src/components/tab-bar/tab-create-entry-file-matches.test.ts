import { expect, it, vi } from 'vitest'
import { prepareQuickOpenFiles } from '../quick-open-search'
import { findExistingFileMatches } from './tab-create-entry-file-matches'
import type * as QuickOpenSearch from '../quick-open-search'

const ranking = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../quick-open-search', async (importOriginal) => {
  const original = await importOriginal<typeof QuickOpenSearch>()
  return {
    ...original,
    rankQuickOpenFiles: (...args: Parameters<typeof original.rankQuickOpenFiles>) => {
      ranking.calls++
      return original.rankQuickOpenFiles(...args)
    }
  }
})

it('skips fuzzy ranking when exact matches fill the requested window', () => {
  const files = prepareQuickOpenFiles(
    Array.from({ length: 10000 }, (_, index) => `${index}/readme.md`)
  )
  ranking.calls = 0
  const matches = findExistingFileMatches('readme.md', files, 10)
  expect(matches.map((match) => match.relativePath)).toEqual(
    files.slice(0, 10).map((file) => file.path)
  )
  expect(matches.every((match) => match.matchKind === 'exact-basename')).toBe(true)
  expect(ranking.calls).toBe(0)
})

it('deduplicates exact paths and still fills remaining slots with fuzzy matches', () => {
  const files = prepareQuickOpenFiles(['a.md', 'a.md', 'other/a.md', 'abc.md'])
  expect(findExistingFileMatches('a.md', files, 4)).toEqual([
    { kind: 'existing-file', matchKind: 'exact-path', relativePath: 'a.md' },
    { kind: 'existing-file', matchKind: 'exact-basename', relativePath: 'other/a.md' },
    { kind: 'existing-file', matchKind: 'fuzzy', relativePath: 'abc.md' }
  ])
})
