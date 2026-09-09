// Durable home for payload bytes the live timeline cannot hold.
//
// A row every reconnecting client replays must stay small, so an oversized tool
// result, diff, or assistant message is clipped to a head. The remainder is
// written HERE first, addressed by the sha256 the bound already computes, so the
// clip is a display bound rather than a delete.
//
// Content addressing makes retention idempotent: an item republished at a new
// revision, or two tools returning the same output, retain once. The store lives
// inside the session's journal directory, so removing a session removes its
// payloads with it and nothing has to reference-count them.
//
// Retention is best effort BY DESIGN. A failed write leaves the row exactly as
// it is bounded today and never worse, because refusing the append instead would
// turn a full disk into a lost turn.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const OVERFLOW_DIR_NAME = 'overflow'

/** Per-session budget for retained remainders. Oldest are evicted first; the
 *  rows keep their head, byte length and digest either way. */
export const JOURNAL_OVERFLOW_QUOTA_BYTES = 64 * 1024 * 1024

/** Where the remainder of a bounded payload goes. `retain` answers whether the
 *  bytes are now durable, which is what the row records as `spilled`. */
export type JournalOverflowSink = {
  retain: (digest: string, payload: string) => boolean
}

/** For bounds applied to derived identifiers — a prompt option id, a turn
 *  ordinal map, an image reference — where the clipped tail is a key fragment
 *  and not user data. Named so the choice is visible at the call site. */
export const JOURNAL_OVERFLOW_NOT_RETAINED: JournalOverflowSink = { retain: () => false }

export function journalOverflowDirectory(journalDir: string): string {
  return join(journalDir, OVERFLOW_DIR_NAME)
}

export function journalOverflowFile(journalDir: string, digest: string): string {
  return join(journalOverflowDirectory(journalDir), `${digest}.txt`)
}

/** Retained bytes for a digest, or null when the payload was never retained or
 *  has since been evicted. */
export function readJournalOverflow(journalDir: string, digest: string): string | null {
  try {
    return readFileSync(journalOverflowFile(journalDir, digest), 'utf8')
  } catch {
    return null
  }
}

export function journalOverflowSink(
  journalDir: string,
  quotaBytes: number = JOURNAL_OVERFLOW_QUOTA_BYTES
): JournalOverflowSink {
  return {
    retain: (digest, payload) => retainJournalOverflow(journalDir, digest, payload, quotaBytes)
  }
}

function retainJournalOverflow(
  journalDir: string,
  digest: string,
  payload: string,
  quotaBytes: number
): boolean {
  const bytes = Buffer.from(payload, 'utf8')
  // A single payload larger than the whole budget would evict everything else
  // to store one item; the row's head, length and digest still describe it.
  if (bytes.byteLength > quotaBytes) {
    return false
  }
  const file = journalOverflowFile(journalDir, digest)
  try {
    if (existsSync(file)) {
      return true
    }
    const directory = journalOverflowDirectory(journalDir)
    mkdirSync(directory, { recursive: true })
    evictJournalOverflow(directory, quotaBytes - bytes.byteLength)
    writeOverflowFile(directory, file, digest, bytes)
    return true
  } catch {
    return false
  }
}

/** Durable before the rename, so a reader never sees a half-written payload
 *  under a digest that claims to describe it. */
function writeOverflowFile(directory: string, file: string, digest: string, bytes: Buffer): void {
  const staging = join(directory, `${digest}.${process.pid}.partial`)
  const handle = openSync(staging, 'w')
  try {
    writeSync(handle, bytes)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  try {
    renameSync(staging, file)
  } catch (error) {
    rmSync(staging, { force: true })
    throw error
  }
}

/** Oldest-first, down to `budget`. Retained payloads are recoverable evidence,
 *  not the timeline: shedding the oldest is how the sidecar stays bounded. */
function evictJournalOverflow(directory: string, budget: number): void {
  const entries: { path: string; bytes: number; modifiedAt: number }[] = []
  let total = 0
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    try {
      const stats = statSync(path)
      if (!stats.isFile()) {
        continue
      }
      entries.push({ path, bytes: stats.size, modifiedAt: stats.mtimeMs })
      total += stats.size
    } catch {
      // Raced with another eviction; it is already gone.
    }
  }
  if (total <= budget) {
    return
  }
  entries.sort((a, b) => a.modifiedAt - b.modifiedAt)
  for (const entry of entries) {
    if (total <= budget) {
      return
    }
    try {
      rmSync(entry.path, { force: true })
      total -= entry.bytes
    } catch {
      // Left in place; the next retention pass tries again.
    }
  }
}
