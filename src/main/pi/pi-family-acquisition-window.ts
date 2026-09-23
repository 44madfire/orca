import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { PiFamilyRpcConnection } from './rpc/pi-family-rpc-connection'

// Bounded pre-publication buffer for Pi-family acquisition (PIF-5, #26).
//
// Provider events may arrive before acquisition publication (OMP emits
// `ready`/`available_commands_update` during startup). They wait here instead
// of reaching no subscriber: bounded by count and bytes, drained in order on
// success, discarded on failure/supersede. Overflow fails acquisition rather
// than silently dropping history. In-memory only, never a durable queue.

export const MAX_PI_FAMILY_ACQUISITION_BUFFER_OPERATIONS = 1024
export const MAX_PI_FAMILY_ACQUISITION_BUFFER_BYTES = 4 * 1024 * 1024

export type PiFamilyAcquisitionBufferLimits = {
  readonly maxOperations?: number
  readonly maxBytes?: number
}

export function estimatePiFamilyRecordBytes(record: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(record) ?? '', 'utf8')
  } catch {
    return 256
  }
}

export type PiFamilyAcquisitionRecordHandler = (record: Record<string, unknown>) => void

/**
 * One acquisition's window plus its sink backpressure binding. The driver
 * taps the transport pre-start through `begin`, drains (or throws
 * `PI_ACQUIRE_OVERFLOW`) at publication through `finish`, and unbinds plus
 * discards through `teardown` on close. In-memory only, never journaled.
 */
export class PiFamilyAcquisitionGate {
  private window: PiFamilyAcquisitionWindow | null = null
  private unbindReadingControl: (() => void) | null = null

  constructor(private readonly limits?: PiFamilyAcquisitionBufferLimits) {}

  begin(
    conn: PiFamilyRpcConnection | null,
    onRecord: PiFamilyAcquisitionRecordHandler
  ): void {
    if (!conn) {
      return
    }
    const limits = this.limits
    this.window = new PiFamilyAcquisitionWindow({
      ...(limits?.maxOperations !== undefined ? { maxOperations: limits.maxOperations } : {}),
      ...(limits?.maxBytes !== undefined ? { maxBytes: limits.maxBytes } : {})
    })
    conn.onEvent((record) => this.route(record, onRecord))
  }

  finish(
    conn: PiFamilyRpcConnection,
    sink: StructuredAgentSessionEventSink | null,
    onRecord: PiFamilyAcquisitionRecordHandler
  ): void {
    const window = this.window
    if (!window) {
      return
    }
    if (window.isOverflowed) {
      throw new Error(
        'PI_ACQUIRE_OVERFLOW: Pi-family startup events exceeded the bounded pre-publication buffer (reacquire the session)'
      )
    }
    for (const record of window.drain()) {
      onRecord(record)
    }
    // Sink pressure drives the selected provider stdout; teardown unbinds.
    this.unbindReadingControl =
      sink?.bindReadingControl?.({
        pauseReading: () => conn.pauseReading(),
        resumeReading: () => conn.resumeReading()
      }) ?? null
  }

  teardown(): void {
    this.unbindReadingControl?.()
    this.unbindReadingControl = null
    this.window?.fail()
    this.window = null
  }

  private route(record: Record<string, unknown>, onRecord: PiFamilyAcquisitionRecordHandler): void {
    const window = this.window
    if (window) {
      if (window.buffer(record, estimatePiFamilyRecordBytes(record))) {
        return
      }
      if (window.isOverflowed) {
        return
      }
    }
    onRecord(record)
  }
}

export class PiFamilyAcquisitionWindow {
  private readonly buffered: Record<string, unknown>[] = []
  private retainedBytes = 0
  private open = true
  private overflowed = false
  private readonly maxOperations: number
  private readonly maxBytes: number

  constructor(limits: PiFamilyAcquisitionBufferLimits = {}) {
    this.maxOperations = limits.maxOperations ?? MAX_PI_FAMILY_ACQUISITION_BUFFER_OPERATIONS
    this.maxBytes = limits.maxBytes ?? MAX_PI_FAMILY_ACQUISITION_BUFFER_BYTES
  }

  get isOverflowed(): boolean {
    return this.overflowed
  }

  /** False once drained/failed; the caller then delivers live. */
  buffer(record: Record<string, unknown>, retainedBytes = 256): boolean {
    if (!this.open) {
      return false
    }
    const bytes = Number.isFinite(retainedBytes) && retainedBytes > 0 ? Math.ceil(retainedBytes) : 1
    if (this.buffered.length >= this.maxOperations || this.retainedBytes + bytes > this.maxBytes) {
      this.overflowed = true
      this.open = false
      this.buffered.length = 0
      this.retainedBytes = 0
      return false
    }
    this.buffered.push(record)
    this.retainedBytes += bytes
    return true
  }

  /** Discard without delivery (failed/superseded acquisition). */
  fail(): void {
    this.open = false
    this.buffered.length = 0
    this.retainedBytes = 0
  }

  /** Close and hand back what arrived while open, in order. */
  drain(): Record<string, unknown>[] {
    this.open = false
    this.retainedBytes = 0
    return this.buffered.splice(0)
  }
}
