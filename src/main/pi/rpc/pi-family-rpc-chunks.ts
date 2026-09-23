// Bounded OMP `rpc_chunk` reassembly (PIF-2, 44madfire/orca#23).
//
// Mirrors the validation in canonical can1357/oh-my-pi
// `packages/coding-agent/src/modes/rpc/rpc-frame.ts` (`RpcFrameDecoder`) at
// merge `6f2233877756b5553ce520756dd90315d2ff6ee3`: chunkId/index/count/
// byteLength shape checks, strict base64, in-order concatenation, advertised
// reassembly ceiling, strict UTF-8, one JSON object out. Transport plumbing
// only: violations surface as thrown protocol errors the connection bounds
// and counts as malformed, never as crashes.

import { isOmpChunkFrame } from './pi-family-rpc-types'

/** Physical stdout frame ceiling (protocol v1 single-line limit). */
export const PI_FAMILY_MAX_FRAME_BYTES = 1_024 * 1_024

/** Logical reassembled frame ceiling (protocol v2 opt-in lossless bound). */
export const PI_FAMILY_MAX_REASSEMBLED_BYTES = 64 * 1_024 * 1_024

const CHUNK_PAYLOAD_BYTES = 256 * 1_024
const CHUNK_ID_MAX_CHARS = 128
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function decodeChunkData(data: unknown): Buffer {
  if (typeof data !== 'string' || data.length === 0 || !BASE64_RE.test(data)) {
    throw new Error('invalid rpc chunk data')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) {
    throw new Error('invalid rpc chunk data')
  }
  return bytes
}

export class PiFamilyChunkDecoder {
  private chunkId: string | null = null
  private count = 0
  private byteLength = 0
  private nextIndex = 0
  private readonly chunks: Buffer[] = []
  private receivedBytes = 0
  private readonly maxReassembledBytes: number

  constructor(maxReassembledBytes = PI_FAMILY_MAX_REASSEMBLED_BYTES) {
    this.maxReassembledBytes = maxReassembledBytes
  }

  get hasPending(): boolean {
    return this.chunkId !== null
  }

  get capacity(): number {
    return this.maxReassembledBytes
  }

  reset(): void {
    this.chunkId = null
    this.count = 0
    this.byteLength = 0
    this.nextIndex = 0
    this.chunks.splice(0)
    this.receivedBytes = 0
  }

  /**
   * Feed one parsed JSONL value. Returns the reassembled object when the
   * final chunk lands, `undefined` while more chunks are needed. Throws on
   * any protocol violation; the caller bounds it as malformed and resets.
   */
  push(value: unknown): object | undefined {
    if (!isOmpChunkFrame(value)) {
      if (this.chunkId !== null) {
        throw new Error('rpc chunk sequence interrupted')
      }
      throw new Error('not a chunk frame')
    }
    const { chunkId, index, count, byteLength } = value
    const maxCount = Math.ceil(this.maxReassembledBytes / CHUNK_PAYLOAD_BYTES)
    if (
      chunkId.length === 0 ||
      chunkId.length > CHUNK_ID_MAX_CHARS ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      index < 0 ||
      count < 2 ||
      count > maxCount ||
      index >= count ||
      byteLength < PI_FAMILY_MAX_FRAME_BYTES ||
      byteLength > this.maxReassembledBytes
    ) {
      throw new Error('invalid rpc chunk metadata')
    }
    const bytes = decodeChunkData(value.data)
    if (bytes.byteLength > CHUNK_PAYLOAD_BYTES) {
      throw new Error('rpc chunk payload exceeds the transport limit')
    }
    if (this.chunkId === null) {
      if (index !== 0) {
        throw new Error('rpc chunk sequence must start at index 0')
      }
      this.chunkId = chunkId
      this.count = count
      this.byteLength = byteLength
      this.nextIndex = 0
    } else {
      if (
        this.chunkId !== chunkId ||
        this.count !== count ||
        this.byteLength !== byteLength ||
        this.nextIndex !== index
      ) {
        throw new Error('rpc chunk sequence mismatch')
      }
    }
    this.chunks.push(bytes)
    this.receivedBytes += bytes.byteLength
    this.nextIndex += 1
    if (this.receivedBytes > this.byteLength) {
      throw new Error('rpc chunk sequence exceeds declared length')
    }
    if (this.nextIndex < this.count) {
      return undefined
    }
    if (this.receivedBytes !== this.byteLength) {
      throw new Error('rpc chunk sequence length mismatch')
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this.chunks))
    this.reset()
    const frame: unknown = JSON.parse(decoded)
    if (!frame || typeof frame !== 'object') {
      throw new Error('rpc frame must be an object')
    }
    return frame
  }
}
