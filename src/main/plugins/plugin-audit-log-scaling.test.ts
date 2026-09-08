import { expect, it, vi } from 'vitest'
import { PluginAuditLog } from './plugin-audit-log'

const source = vi.hoisted(() => ({ content: '' }))
vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => (path.endsWith('.1') ? '' : source.content)
}))

it('extracts the recent window without splitting all historical log records', async () => {
  source.content = `${Array.from({ length: 10000 }, (_, ts) => JSON.stringify({ ts })).join('\n')}\n`
  const split = vi.spyOn(String.prototype, 'split')
  let entries: Awaited<ReturnType<PluginAuditLog['readRecent']>>
  try {
    entries = await new PluginAuditLog('/logs').readRecent(200)
    expect(split.mock.calls.length).toBe(0)
  } finally {
    split.mockRestore()
  }
  expect(entries!.map((entry) => entry.ts)).toEqual(
    Array.from({ length: 200 }, (_, index) => 9800 + index)
  )
})

it('preserves blank, malformed, unterminated and unusual-limit selection', async () => {
  source.content = '\n{"ts":1}\n\ninvalid\n \n{"ts":2}'
  const original = (limit: number) =>
    source.content
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
  const log = new PluginAuditLog('/logs')
  for (const limit of [1, 2, 3, 4, 5, 0, -1, 0.5, 1.5, Infinity, Number.NaN]) {
    expect(await log.readRecent(limit)).toEqual(original(limit))
  }
})
