import { StringDecoder } from 'node:string_decoder'
import { serviceExecutionError } from './plugin-service-execution-errors'

export type SidecarResponseEnvelope = {
  id: string
  result?: unknown
  error?: unknown
}

export type JsonlFramerEvents = {
  onMessage: (value: unknown) => void
  onFramingError: (error: Error) => void
}

// Strict bounded JSONL framer. Incremental UTF-8 decoding keeps a multibyte
// character split across chunks intact; an overlong line errors the stream
// and resyncs at the next LF instead of growing the heap.
export function createJsonlFramer(
  serviceId: string,
  maxLineBytes: number,
  events: JsonlFramerEvents
): { push: (chunk: Buffer) => void; finish: () => void } {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let bufferBytes = 0
  let overlong = false

  const emitLine = (line: string): void => {
    if (line.length === 0) {
      return
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      events.onFramingError(
        serviceExecutionError('malformed-response', serviceId, 'sidecar sent invalid JSON')
      )
      return
    }
    events.onMessage(value)
  }

  const scan = (): void => {
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index === -1) {
        return
      }
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (overlong) {
        // Dropped the overlong prefix; this LF ends the resync window.
        overlong = false
        bufferBytes = Buffer.byteLength(buffer, 'utf8')
        continue
      }
      bufferBytes = Buffer.byteLength(buffer, 'utf8')
      emitLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
    }
  }

  return {
    push(chunk: Buffer): void {
      buffer += decoder.write(chunk)
      bufferBytes += chunk.length
      if (overlong) {
        // Still discarding; scan() drops through the resync LF.
        scan()
        return
      }
      if (bufferBytes > maxLineBytes) {
        const index = buffer.indexOf('\n')
        if (index === -1) {
          overlong = true
          buffer = ''
          bufferBytes = 0
          events.onFramingError(
            serviceExecutionError('malformed-response', serviceId, 'sidecar line exceeds bound')
          )
          return
        }
        // Overlong prefix before the first LF: drop through it, keep the rest.
        buffer = buffer.slice(index + 1)
        bufferBytes = Buffer.byteLength(buffer, 'utf8')
        events.onFramingError(
          serviceExecutionError('malformed-response', serviceId, 'sidecar line exceeds bound')
        )
      }
      scan()
    },
    finish(): void {
      buffer += decoder.end()
      if (overlong || buffer.length === 0) {
        return
      }
      if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
        events.onFramingError(
          serviceExecutionError('malformed-response', serviceId, 'sidecar line exceeds bound')
        )
        return
      }
      emitLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer)
      buffer = ''
      bufferBytes = 0
    }
  }
}

export function encodeSidecarRequest(id: string, payload: unknown): Buffer {
  return Buffer.from(`${JSON.stringify({ id, params: payload })}\n`, 'utf8')
}

export function jsonBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value ?? null)
    return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : null
  } catch {
    return null
  }
}

const MAX_ENVELOPE_ID_LENGTH = 128

// Provider-neutral response shape: {id, result?} or {id, error?}.
// Anything else is malformed; never surfaces raw subprocess text.
export function decodeSidecarEnvelope(value: unknown): SidecarResponseEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    record.id.length > MAX_ENVELOPE_ID_LENGTH
  ) {
    return null
  }
  if (!('result' in record) && !('error' in record)) {
    return null
  }
  return { id: record.id, result: record.result, error: record.error }
}
