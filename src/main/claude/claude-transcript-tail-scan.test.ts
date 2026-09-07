import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  claudeTranscriptTailLines,
  TRANSCRIPT_TAIL_READ_LIMIT_BYTES,
  type ClaudeTranscriptTailScan
} from './claude-transcript-tail-scan'

const CHUNK_BYTES = 64 * 1024

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-tail-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(name: string, content: Buffer | string): Promise<string> {
  const path = join(root, name)
  await writeFile(path, content)
  return path
}

async function collect(path: string, scan?: ClaudeTranscriptTailScan): Promise<string[]> {
  const lines: string[] = []
  for await (const line of claudeTranscriptTailLines(path, scan)) {
    lines.push(line)
  }
  return lines
}

/** A file whose 64KiB chunk boundary lands inside `marker`'s multi-byte run. */
function fileSplittingInside(marker: string, targetLine: string): Buffer {
  const line = Buffer.from(`${targetLine}\n`, 'utf8')
  const markerBytes = Buffer.from(marker, 'utf8')
  const markerAt = line.indexOf(markerBytes)
  expect(markerAt).toBeGreaterThanOrEqual(0)
  // Split on the marker's SECOND byte, so the character straddles the boundary.
  const splitWithinLine = markerAt + 1
  const trailing = CHUNK_BYTES - (line.length - splitWithinLine)
  expect(trailing).toBeGreaterThan(0)
  const head = Buffer.from('{"type":"user","sessionId":"session-1"}\n', 'utf8')
  const tail = Buffer.from(`${'x'.repeat(trailing - 1)}\n`, 'utf8')
  const file = Buffer.concat([head, line, tail])
  // The boundary the reader will use is exactly the marker's continuation byte.
  const boundary = file.length - CHUNK_BYTES
  expect(boundary).toBe(head.length + splitWithinLine)
  expect(file[boundary]! & 0xc0).toBe(0x80)
  return file
}

describe('claudeTranscriptTailLines', () => {
  it('keeps a multi-byte character intact when it straddles a chunk boundary', async () => {
    const targetLine = '{"type":"ai-title","aiTitle":"Café ☕","sessionId":"session-1"}'
    const path = await write('boundary.jsonl', fileSplittingInside('é', targetLine))

    await expect(collect(path)).resolves.toContain(targetLine)
  })

  it('keeps a 3-byte character intact when it straddles a chunk boundary', async () => {
    const targetLine = '{"type":"ai-title","aiTitle":"Résumé du fil ☕","sessionId":"s"}'
    const path = await write('boundary-3.jsonl', fileSplittingInside('☕', targetLine))

    await expect(collect(path)).resolves.toContain(targetLine)
  })

  it('yields every non-empty line newest first', async () => {
    const path = await write('small.jsonl', 'a\n\nb\nc\n')

    await expect(collect(path)).resolves.toEqual(['c', 'b', 'a'])
  })

  it('reports reaching the start of a file it read entirely', async () => {
    const path = await write('small.jsonl', 'a\nb\n')
    const scan: ClaudeTranscriptTailScan = { reachedFileStart: false }

    await collect(path, scan)

    expect(scan.reachedFileStart).toBe(true)
  })

  it('does not report reaching the start when the read limit cut the scan short', async () => {
    const line = `${'x'.repeat(1023)}\n`
    const path = await write(
      'huge.jsonl',
      Buffer.from(line.repeat(Math.ceil(TRANSCRIPT_TAIL_READ_LIMIT_BYTES / 1024) + 8), 'utf8')
    )
    const scan: ClaudeTranscriptTailScan = { reachedFileStart: false }

    await collect(path, scan)

    expect(scan.reachedFileStart).toBe(false)
  })
})
