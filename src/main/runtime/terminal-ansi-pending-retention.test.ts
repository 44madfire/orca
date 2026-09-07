import { describe, expect, it, vi } from 'vitest'
import * as ownedSuffix from '../../shared/owned-utf16-suffix'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'
import { MAX_TAIL_PENDING_ANSI_CHARS } from './terminal-tail-limits'

const INCOMPLETE_STATUS = '\x1b]9999;{"state":"working","prompt":"fragment'

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

describe('terminal preview pending ANSI storage', () => {
  it.each([
    [16 * 1024, 256, INCOMPLETE_STATUS],
    [64 * 1024, 64, INCOMPLETE_STATUS],
    [1024 * 1024, 16, INCOMPLETE_STATUS],
    [16 * 1024, 128, INCOMPLETE_STATUS + 'x'.repeat(16 * 1024)]
  ])('releases %i-character prefixes behind %i incomplete statuses', (size, count, control) => {
    for (let index = 0; index < 100; index++) {
      normalizeTerminalChunk(INCOMPLETE_STATUS)
    }
    const tails: string[] = []
    const before = collectHeap()
    let cleanChars = 0
    for (let index = 0; index < count; index++) {
      const result = normalizeTerminalChunk(
        String.fromCharCode(65 + (index % 26)).repeat(size) + control
      )
      cleanChars += result.text.length
      tails.push(result.pendingAnsi)
    }
    const retainedBytes = collectHeap() - before

    expect(cleanChars).toBe(size * count)
    expect(retainedBytes).toBeLessThan(2 * 1024 * 1024)
    const expected =
      control.length <= MAX_TAIL_PENDING_ANSI_CHARS
        ? control
        : control.slice(0, 2) + control.slice(-(MAX_TAIL_PENDING_ANSI_CHARS - 2))
    for (const pending of tails) {
      expect(pending).toBe(expected)
      expect(normalizeTerminalChunk('"}\x07after', pending)).toEqual({
        text: 'after',
        pendingAnsi: ''
      })
    }
  })

  it.each(['\x1b]', '\x1bP', '\x1b['])('preserves trimming and code units for %j', (prefix) => {
    for (const length of [4095, 4096, 4097, 16 * 1024]) {
      const value = `${prefix}${'x'.repeat(length - 7)}漢\ud8001\udc00\ud83d`
      const expected =
        value.length <= MAX_TAIL_PENDING_ANSI_CHARS
          ? value
          : prefix + value.slice(-(MAX_TAIL_PENDING_ANSI_CHARS - prefix.length))
      // CSI parameters must stay below its final-byte range until the suffix is retained.
      const input = prefix === '\x1b[' ? value.replaceAll('x', '1') : value
      const expectedInput = prefix === '\x1b[' ? expected.replaceAll('x', '1') : expected
      const result = normalizeTerminalChunk('a'.repeat(32 * 1024) + input)
      expect(result).toEqual({ text: 'a'.repeat(32 * 1024), pendingAnsi: expectedInput })
    }
  })

  it.each(['\x07', '\x1b\\'])('preserves split UTF-16 through %j termination', (terminator) => {
    const pending = '\x1b]2;漢\ud800|\udc00|\ud83d'
    const first = normalizeTerminalChunk('x'.repeat(16 * 1024) + pending)
    expect(first.pendingAnsi).toBe(pending)
    expect(normalizeTerminalChunk(`\ude00${terminator}after`, first.pendingAnsi)).toEqual({
      text: 'after',
      pendingAnsi: ''
    })
  })

  it('does not copy an incomplete control while ordinary fragments grow and trim it', () => {
    const copy = vi.spyOn(ownedSuffix, 'copyUtf16SuffixToOwnedString')
    let pending = '\x1b]2;'
    try {
      for (let index = 0; index < 128; index++) {
        pending = normalizeTerminalChunk('x'.repeat(512), pending).pendingAnsi
      }
      expect(copy).not.toHaveBeenCalled()
    } finally {
      copy.mockRestore()
    }
    expect(pending).toBe(`\x1b]${'x'.repeat(MAX_TAIL_PENDING_ANSI_CHARS - 2)}`)
    expect(normalizeTerminalChunk('\x07after', pending)).toEqual({ text: 'after', pendingAnsi: '' })
  })
})
