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
