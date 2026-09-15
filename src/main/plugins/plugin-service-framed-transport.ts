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
// character split across chunks intact. The byte bound applies to each
// complete line independently — coalesced responses in one chunk are all
// valid — and only the trailing partial line is bounded while incomplete.
// An overlong line errors and resyncs at the next LF instead of growing
// the heap.
export function createJsonlFramer(
  serviceId: string,
  maxLineBytes: number,
  events: JsonlFramerEvents
): { push: (chunk: Buffer) => void; finish: () => void } {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
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

  const overlongLine = (): void => {
    events.onFramingError(
      serviceExecutionError('malformed-response', serviceId, 'sidecar line exceeds bound')
    )
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
        // Dropped the overlong tail; this LF ends the resync window.
        overlong = false
        continue
      }
      if (Buffer.byteLength(raw, 'utf8') > maxLineBytes) {
        // One overlong line is dropped; the stream continues after it.
        overlongLine()
        continue
      }
      emitLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
    }
  }

  return {
    push(chunk: Buffer): void {
      buffer += decoder.write(chunk)
      scan()
      if (overlong) {
        // Still inside the overlong line: keep nothing while waiting for
        // its LF, or an LF-less line would grow the heap unchecked.
        buffer = ''
        return
      }
      // Only the incomplete tail is bounded: complete lines above were
      // already measured one by one.
      if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
        overlong = true
        buffer = ''
        overlongLine()
      }
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
