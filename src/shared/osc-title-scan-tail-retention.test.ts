import { describe, expect, it, vi } from 'vitest'
import * as ownedSuffix from './owned-utf16-suffix'
import { extractOscTitleScanTail } from './osc-title-scan-tail'

const INCOMPLETE_TITLE = '\x1b]2;Working on a terminal title'

function collectHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) {
    throw new Error('global.gc unavailable; run with --expose-gc')
  }
  void /reset/.test('reset')
  gc()
  gc()
  return process.memoryUsage().heapUsed
}

describe('OSC title scan tail storage', () => {
  it.each([
    [16 * 1024, 256, INCOMPLETE_TITLE],
    [64 * 1024, 64, INCOMPLETE_TITLE],
    [1024 * 1024, 16, INCOMPLETE_TITLE],
    [16 * 1024, 128, INCOMPLETE_TITLE + 'x'.repeat(16 * 1024)]
  ])('releases %i-character prefixes behind %i incomplete titles', (size, count, title) => {
    const tails: string[] = []
    for (let index = 0; index < 100; index++) {
      extractOscTitleScanTail(INCOMPLETE_TITLE)
    }
    const before = collectHeap()
    for (let index = 0; index < count; index++) {
      tails.push(
        extractOscTitleScanTail(String.fromCharCode(65 + (index % 26)).repeat(size) + title)
      )
    }
    const retainedBytes = collectHeap() - before

    expect(retainedBytes).toBeLessThan(2 * 1024 * 1024)
    const expected = title.length <= 4096 ? title : title.slice(0, 4) + title.slice(-4092)
    expect(tails).toEqual(Array.from({ length: count }, () => expected))
  })

  it.each(['0', '1', '2'])('preserves title %s introducer and exact UTF-16 at the cap', (code) => {
    const prefix = `\x1b]${code};`
    for (const length of [4095, 4096, 4097, 16 * 1024]) {
      const value = `${prefix}${'x'.repeat(length - 9)}漢\ud800|\udc00\ud83d`
      const expected = value.length <= 4096 ? value : prefix + value.slice(-4092)
      const tail = extractOscTitleScanTail('a'.repeat(32 * 1024) + value)
      expect(tail).toBe(expected)
      expect(extractOscTitleScanTail(`${tail}\ude00\x1b\\`)).toBe('')
    }
  })

  it('does not copy ordinary growing tails or unrelated incomplete OSC sequences', () => {
    const copy = vi.spyOn(ownedSuffix, 'copyUtf16SuffixToOwnedString')
    let pending = '\x1b]2;'
    try {
      for (let index = 0; index < 128; index++) {
        pending = extractOscTitleScanTail(pending + 'x'.repeat(512))
      }
      expect(extractOscTitleScanTail(`${'x'.repeat(32 * 1024)}\x1b]9999;incomplete`)).toBe('')
      expect(copy).not.toHaveBeenCalled()
    } finally {
      copy.mockRestore()
    }
    expect(pending).toBe(`\x1b]2;${'x'.repeat(4092)}`)
  })
})
