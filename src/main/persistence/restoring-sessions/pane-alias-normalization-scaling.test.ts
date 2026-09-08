import { expect, it, vi } from 'vitest'
import type { MigrationUnsupportedPtyEntry } from '../../../shared/agent-status-types'
import { legacyMigrationUnsupportedRowsToAliasEntries } from './pane-alias-normalization'

vi.mock('../../agent-hooks/server', () => ({ agentHookServer: {} }))

it('retains only the ambiguity verdict when many legacy rows name the same tab', () => {
  const row: MigrationUnsupportedPtyEntry = {
    ptyId: 'pty',
    tabId: 'tab',
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    reason: 'legacy-numeric-pane-key',
    source: 'local',
    updatedAt: 1
  }
  const rows = Array.from({ length: 2000 }, () => row)
  const iterator = Array.prototype[Symbol.iterator]
  let copied = 0
  Array.prototype[Symbol.iterator] = function (this: unknown[]) {
    if (this[0] === row) {
      copied += this.length
    }
    return iterator.call(this)
  }
  let aliases: ReturnType<typeof legacyMigrationUnsupportedRowsToAliasEntries>
  try {
    aliases = legacyMigrationUnsupportedRowsToAliasEntries(rows)
  } finally {
    Array.prototype[Symbol.iterator] = iterator
  }
  expect(copied).toBeLessThan(10_000)
  expect(aliases).toEqual([])
  const unique = legacyMigrationUnsupportedRowsToAliasEntries([row])
  expect(unique.map((entry) => entry.legacyPaneKey)).toEqual(['tab:0', 'tab:1'])
  expect(unique.every((entry) => entry.stablePaneKey === row.paneKey)).toBe(true)
})
