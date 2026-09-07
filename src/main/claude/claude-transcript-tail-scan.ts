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
 * Each read is aligned to end just past a newline, so no line ever straddles a
 * block and nothing has to be carried between iterations. Carrying a partial as
 * TEXT was the bug this shape removes: decoding a block in isolation turns a
 * multi-byte character straddling the boundary into U+FFFD on both sides, and
 * the mojibake still parses as JSON, so nothing fails closed. Carrying it as
 * bytes would fix that but rebuild a growing buffer every iteration; re-reading
 * the one partial line instead costs a bounded overlap and no allocation.
 */
export async function* claudeTranscriptTailLines(
  transcriptPath: string,
  scan?: ClaudeTranscriptTailScan
): AsyncGenerator<string, void, undefined> {
  const file = await open(transcriptPath, 'r')
  try {
    const { size } = await file.stat()
    let end = size
    let span = TRANSCRIPT_TAIL_CHUNK_BYTES
    let scanned = 0
    if (scan) {
      scan.reachedFileStart = end === 0
    }
    while (end > 0 && scanned < TRANSCRIPT_TAIL_READ_LIMIT_BYTES) {
      const position = Math.max(0, end - span)
      const length = end - position
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, position)
      scanned = size - position
      const boundary = position > 0 ? buffer.indexOf(NEWLINE) : -1
      if (position > 0 && boundary === -1) {
        // A line longer than the window. Widen it rather than carry its bytes.
        span += TRANSCRIPT_TAIL_CHUNK_BYTES
        continue
      }
      if (scan) {
        scan.reachedFileStart = position === 0
      }
      // Safe to decode: `from` follows a newline (or is the file's start) and
      // `end` is the file's end or one past a newline.
      const from = boundary + 1
      const lines = buffer.subarray(from).toString('utf8').split(/\r?\n/)
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim()
        if (line) {
          yield line
        }
      }
      end = position + from
      span = TRANSCRIPT_TAIL_CHUNK_BYTES
    }
  } finally {
    await file.close()
  }
}
