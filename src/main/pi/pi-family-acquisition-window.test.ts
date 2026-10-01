// Pi-family acquisition-window tests (PIF-5, #26).
//
// Pre-publication buffering is bounded by count and bytes: overflow fails the
// acquisition instead of silently dropping history, and failed or superseded
// attempts discard their buffers. In-memory only, never a durable queue.

import { describe, expect, it } from 'vitest'
import {
  MAX_PI_FAMILY_ACQUISITION_BUFFER_BYTES,
  MAX_PI_FAMILY_ACQUISITION_BUFFER_OPERATIONS,
  PiFamilyAcquisitionWindow
} from './pi-family-acquisition-window'

function record(id: string): Record<string, unknown> {
  return { type: 'message_update', id }
}

describe('PiFamilyAcquisitionWindow', () => {
  it('delivers buffered records in order after successful publication', () => {
    const window = new PiFamilyAcquisitionWindow()
    expect(window.buffer(record('a'), 10)).toBe(true)
    expect(window.buffer(record('b'), 10)).toBe(true)
    expect(window.buffer(record('c'), 10)).toBe(true)
    const drained = window.drain()
    expect(drained.map((entry) => entry['id'])).toEqual(['a', 'b', 'c'])
  })

  it('stops accepting after drain, which is the live-delivery cue', () => {
    const window = new PiFamilyAcquisitionWindow()
    expect(window.buffer(record('a'))).toBe(true)
    expect(window.drain()).toHaveLength(1)
    expect(window.buffer(record('b'))).toBe(false)
    expect(window.isOverflowed).toBe(false)
    expect(window.drain()).toHaveLength(0)
  })

  it('fails on operation-count overflow and discards instead of dropping silently', () => {
    const window = new PiFamilyAcquisitionWindow({ maxOperations: 2 })
    expect(window.buffer(record('a'))).toBe(true)
    expect(window.buffer(record('b'))).toBe(true)
    expect(window.buffer(record('c'))).toBe(false)
    expect(window.isOverflowed).toBe(true)
    expect(window.drain()).toHaveLength(0)
    expect(window.buffer(record('d'))).toBe(false)
  })

  it('fails on byte overflow', () => {
    const window = new PiFamilyAcquisitionWindow({ maxBytes: 10 })
    expect(window.buffer(record('a'), 6)).toBe(true)
    expect(window.buffer(record('b'), 6)).toBe(false)
    expect(window.isOverflowed).toBe(true)
    expect(window.drain()).toHaveLength(0)
  })

  it('discards stale buffers on failure without delivery', () => {
    const window = new PiFamilyAcquisitionWindow()
    expect(window.buffer(record('a'))).toBe(true)
    window.fail()
    expect(window.drain()).toHaveLength(0)
    expect(window.buffer(record('b'))).toBe(false)
  })

  it('bounds production buffers so a provider cannot pin closures', () => {
    expect(MAX_PI_FAMILY_ACQUISITION_BUFFER_OPERATIONS).toBe(1024)
    expect(MAX_PI_FAMILY_ACQUISITION_BUFFER_BYTES).toBe(4 * 1024 * 1024)
  })
})
