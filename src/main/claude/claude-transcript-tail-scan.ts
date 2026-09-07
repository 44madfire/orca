// Reading a Claude transcript backwards, in bounded chunks.
//
// These files reach many megabytes on a long conversation, and the records Orca
// wants from them — the leaf uuid, the session's name — are appended, so the tail
// holds them. Reading the whole file to find a trailing record costs a full parse
// on every acquisition, competing with the attach it runs alongside.
//
// The bound is deliberate: a record older than the limit is NOT found. Every
// caller here treats "not found" as "no answer yet", never as a negative fact.

import { open } from 'node:fs/promises'

const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024
export const TRANSCRIPT_TAIL_READ_LIMIT_BYTES = 4 * 1024 * 1024

/**
 * Every non-empty line of the transcript's tail, newest first, up to the limit.
 *
 * A chunk boundary can split a line, so the leading partial of each chunk is
 * carried into the next (earlier) one rather than parsed as a whole line.
 */
export async function* claudeTranscriptTailLines(
  transcriptPath: string
): AsyncGenerator<string, void, undefined> {
  const file = await open(transcriptPath, 'r')
  try {
    const { size } = await file.stat()
    let position = size
    let suffix = ''
    let scanned = 0
    while (position > 0 && scanned < TRANSCRIPT_TAIL_READ_LIMIT_BYTES) {
      const length = Math.min(TRANSCRIPT_TAIL_CHUNK_BYTES, position)
      position -= length
      scanned += length
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, position)
      const lines = `${buffer.toString('utf8')}${suffix}`.split(/\r?\n/)
      suffix = position > 0 ? (lines.shift() ?? '') : ''
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
