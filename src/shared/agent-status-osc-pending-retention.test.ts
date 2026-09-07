import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusOscProcessor } from './agent-status-osc'

const INCOMPLETE_STATUS = '\x1b]9999;{"state":"working","prompt":"fragment'

function collectHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) {
    throw new Error('global.gc unavailable - config/vitest.config.ts must pass --expose-gc')
  }
  void /reset/.test('reset')
  gc()
  gc()
  return process.memoryUsage().heapUsed
}

describe('OSC 9999 pending storage', () => {
  it.each([
    [16 * 1024, 256],
    [64 * 1024, 64],
    [1024 * 1024, 16]
  ])('releases %i-character output prefixes while %i statuses remain incomplete', (size, count) => {
    const parsers: ReturnType<typeof createAgentStatusOscProcessor>[] = []
    for (let index = 0; index < 100; index += 1) {
      createAgentStatusOscProcessor()(INCOMPLETE_STATUS)
    }
    const before = collectHeap()
    let cleanChars = 0

    for (let index = 0; index < count; index += 1) {
      const process = createAgentStatusOscProcessor()
      cleanChars += process(String.fromCharCode(65 + (index % 26)).repeat(size) + INCOMPLETE_STATUS)
        .cleanData.length
      parsers.push(process)
    }

    const retainedBytes = collectHeap() - before

    expect(cleanChars).toBe(size * count)
    // A few KiB of pending statuses must not pin 4–16 MiB of consumed output.
    expect(retainedBytes).toBeLessThan(2 * 1024 * 1024)
    for (const process of parsers) {
      expect(process('"}\x07after')).toEqual({
        cleanData: 'after',
        payloads: [{ state: 'working', prompt: 'fragment' }],
        lastPayloadCleanOffset: 0
      })
    }
  })

  it.each(['\x07', '\x1b\\'])(
    'preserves raw UTF-16 across an owned suffix and %j',
    (terminator) => {
      const process = createAgentStatusOscProcessor()
      const ordinary = '😀'.repeat(8 * 1024)
      const promptStart = '漢字\ud800|\udc00|\ud83d'

      expect(process(`${ordinary}\x1b]9999;{"state":"working","prompt":"${promptStart}`)).toEqual({
        cleanData: ordinary,
        payloads: [],
        lastPayloadCleanOffset: null
      })
      expect(process(`\ude00"}${terminator}after`)).toEqual({
        cleanData: 'after',
        payloads: [{ state: 'working', prompt: '漢字\ud800|\udc00|😀' }],
        lastPayloadCleanOffset: 0
      })
    }
  )

  it('does not copy a growing incomplete frame on every fragment', () => {
    const process = createAgentStatusOscProcessor()
    const marker = '\x1b]9999;{"state":"working"}'
    const pending = marker + ' '.repeat(64 * 1024 - marker.length)
    const charCodeAt = String.prototype.charCodeAt
    let copiedCodeUnits = 0
    const spy = vi
      .spyOn(String.prototype, 'charCodeAt')
      .mockImplementation(function (this: string, index) {
        copiedCodeUnits += 1
        return charCodeAt.call(this, index)
      })
    try {
      for (let offset = 0; offset < pending.length; offset += 512) {
        process(pending.slice(offset, offset + 512))
      }
    } finally {
      spy.mockRestore()
    }

    expect(copiedCodeUnits).toBe(0)
    expect(process('\x07after')).toEqual({
      cleanData: 'after',
      payloads: [{ state: 'working', prompt: '' }],
      lastPayloadCleanOffset: 0
    })
  })
})
