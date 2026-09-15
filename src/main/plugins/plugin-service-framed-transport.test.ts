import { describe, expect, it } from 'vitest'
import type { ServiceExecutionError } from './plugin-service-execution-errors'
import {
  createJsonlFramer,
  decodeSidecarEnvelope,
  encodeSidecarRequest,
  jsonBytes
} from './plugin-service-framed-transport'

function collect(maxLineBytes = 1024) {
  const messages: unknown[] = []
  const errors: Error[] = []
  const framer = createJsonlFramer('svc.test', maxLineBytes, {
    onMessage: (value) => messages.push(value),
    onFramingError: (error) => errors.push(error)
  })
  return { messages, errors, framer }
}

describe('createJsonlFramer', () => {
  it('parses one message per line', () => {
    const { messages, errors, framer } = collect()
    framer.push(Buffer.from('{"id":"1","result":1}\n{"id":"2","result":2}\n'))
    expect(messages).toEqual([
      { id: '1', result: 1 },
      { id: '2', result: 2 }
    ])
    expect(errors).toEqual([])
  })

  it('reassembles a message split across chunks', () => {
    const { messages, framer } = collect()
    framer.push(Buffer.from('{"id":"1","res'))
    framer.push(Buffer.from('ult":true}\n'))
    expect(messages).toEqual([{ id: '1', result: true }])
  })

  it('keeps a multibyte character split across chunks intact', () => {
    const line = Buffer.from('{"id":"1","result":"caf\u00e9 \u{1F600}"}\n', 'utf8')
    // Split inside the two-byte é and inside the four-byte emoji.
    for (const cut of [22, 24, 27, 30]) {
      const part = collect()
      part.framer.push(line.subarray(0, cut))
      part.framer.push(line.subarray(cut))
      expect(part.messages).toEqual([{ id: '1', result: 'café \u{1F600}' }])
    }
  })

  it('tolerates CRLF and skips blank lines', () => {
    const { messages, framer } = collect()
    framer.push(Buffer.from('\r\n{"id":"1","result":1}\r\n\r\n'))
    expect(messages).toEqual([{ id: '1', result: 1 }])
  })

  it('emits the tail on finish', () => {
    const { messages, framer } = collect()
    framer.push(Buffer.from('{"id":"1","result":1}'))
    expect(messages).toEqual([])
    framer.finish()
    expect(messages).toEqual([{ id: '1', result: 1 }])
  })

  it('errors an overlong line and resyncs at the next LF', () => {
    const { messages, errors, framer } = collect(16)
    framer.push(Buffer.from('{"id":"way-too-long-for-the-bound"}\n{"id":"2","result":2}\n'))
    expect(errors).toHaveLength(1)
    expect((errors[0] as ServiceExecutionError).code).toBe('malformed-response')
    expect(messages).toEqual([{ id: '2', result: 2 }])
  })

  it('drops an overlong line that arrives without any LF', () => {
    const { messages, errors, framer } = collect(8)
    framer.push(Buffer.from('{"id":"no-lf-yet"'))
    expect(errors).toHaveLength(1)
    expect(messages).toEqual([])
    framer.push(Buffer.from('}\n{"id":"2","result":2}\n'))
    expect(messages).toEqual([{ id: '2', result: 2 }])
  })

  it('reports invalid JSON without killing the stream', () => {
    const { messages, errors, framer } = collect()
    framer.push(Buffer.from('not json\n{"id":"1","result":1}\n'))
    expect(errors).toHaveLength(1)
    expect(messages).toEqual([{ id: '1', result: 1 }])
  })
})

describe('decodeSidecarEnvelope', () => {
  it('accepts result and error shapes', () => {
    expect(decodeSidecarEnvelope({ id: 'a', result: 42 })).toEqual({ id: 'a', result: 42 })
    expect(decodeSidecarEnvelope({ id: 'a', error: 'boom' })).toEqual({ id: 'a', error: 'boom' })
  })

  it('rejects shapeless values', () => {
    for (const value of [null, 42, 'x', [], { result: 1 }, { id: '', result: 1 }, { id: 7 }]) {
      expect(decodeSidecarEnvelope(value)).toBeNull()
    }
  })
})

describe('encodeSidecarRequest/jsonBytes', () => {
  it('round-trips through the framer', () => {
    const { messages, framer } = collect()
    framer.push(encodeSidecarRequest('7', { hello: 'world' }))
    expect(messages).toEqual([{ id: '7', params: { hello: 'world' } }])
  })

  it('counts bytes and fails closed on cycles', () => {
    expect(jsonBytes({ a: 1 })).toBeGreaterThan(0)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(jsonBytes(cyclic)).toBeNull()
  })
})
