import { expect, it, vi } from 'vitest'
import { commandLineLength } from './windows-command-line-budget'

it('counts quote-dense payloads without allocating a match array', () => {
  const args = ['node.exe', '-e', '"\\abc'.repeat(6000)]
  const expected = args.reduce(
    (total, arg) => total + arg.length + 3 + (arg.match(/["\\]/g)?.length ?? 0),
    0
  )
  const match = vi.spyOn(String.prototype, 'match')
  try {
    expect(commandLineLength(args)).toBe(expected)
    expect(match.mock.calls.length).toBe(0)
  } finally {
    match.mockRestore()
  }
})

it('preserves empty, Unicode, backslash and quote budget estimates', () => {
  for (const args of [[], [''], ['🦀', 'é', '\\', '"'], ['a\\\\"b', 'plain']]) {
    expect(commandLineLength(args)).toBe(
      args.reduce((total, arg) => total + arg.length + 3 + (arg.match(/["\\]/g)?.length ?? 0), 0)
    )
  }
})
