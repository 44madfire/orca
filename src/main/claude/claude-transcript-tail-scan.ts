// Reading a Claude transcript backwards, in bounded chunks.
//
// These files reach many megabytes on a long conversation, and the records Orca
// wants from them — the leaf uuid, the session's name — are appended, so the tail
// holds them. Reading the whole file to find a trailing record costs a full parse
// on every acquisition, competing with the attach it runs alongside.
//
// The bound is deliberate: a record older than the limit is NOT found. Every
// caller here treats "not found" as "no answer yet", never as a negative fact —
// unless `reachedFileStart` says the whole file was visible.

import { open } from 'node:fs/promises'

const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024
export const TRANSCRIPT_TAIL_READ_LIMIT_BYTES = 4 * 1024 * 1024
const NEWLINE = 0x0a

/** How far back the scan actually got, mutated as it runs. */
export type ClaudeTranscriptTailScan = {
  /** True once every byte of the file has been yielded: "not found" is then a
   *  real negative rather than the bound. */
  reachedFileStart: boolean
}

/**
 * Every non-empty line of the transcript's tail, newest first, up to the limit.
 *
 * A chunk boundary can split a line, so the leading partial of each chunk is
 * carried into the next (earlier) one. The carry stays BYTES: decoding a chunk
 * in isolation turns a multi-byte character straddling the boundary into U+FFFD
 * on both sides, and the mojibake still parses as JSON, so nothing fails closed.
 */
export async function* claudeTranscriptTailLines(
  transcriptPath: string,
  scan?: ClaudeTranscriptTailScan
): AsyncGenerator<string, void, undefined> {
  const file = await open(transcriptPath, 'r')
  try {
    const { size } = await file.stat()
    let position = size
    let carry: Buffer = Buffer.alloc(0)
    let scanned = 0
    if (scan) {
      scan.reachedFileStart = position === 0
    }
    while (position > 0 && scanned < TRANSCRIPT_TAIL_READ_LIMIT_BYTES) {
      const length = Math.min(TRANSCRIPT_TAIL_CHUNK_BYTES, position)
      position -= length
      scanned += length
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, position)
      const block = carry.length > 0 ? Buffer.concat([buffer, carry]) : buffer
      let start = 0
      if (position > 0) {
        const boundary = block.indexOf(NEWLINE)
        // No newline at all: the whole block is one partial line, carry it on.
        start = boundary === -1 ? block.length : boundary + 1
        carry = block.subarray(0, boundary === -1 ? block.length : boundary)
      } else {
        carry = Buffer.alloc(0)
      }
      if (scan) {
        scan.reachedFileStart = position === 0
      }
      // Safe to decode: `start` follows a newline and the far end of `block` is
      // either the file's end or a carry that ended on one.
      const lines = block.subarray(start).toString('utf8').split(/\r?\n/)
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim()
        if (line) {
          yield line
        }
      }
    }
  } finally {
    await file.close()
  }
}
