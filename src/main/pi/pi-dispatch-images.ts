// Pi dispatch image resolution (SNC1.9 native Pi).
//
// Reads `image-ref` blocks into bounded base64 payloads for Pi `prompt`
// images. Follows the Claude dispatch reader's discipline (per-file and
// total budgets, descriptor size proof after the read so a growing file
// cannot smuggle extra bytes in): image bytes ride the RPC but are never
// journaled and never logged. Remote URLs are refused — Pi RPC needs bytes
// and Orca performs no network fetch on the structured path.

import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import { extractPiDispatchText } from './pi-structured-backend'

const MAX_PI_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_PI_IMAGE_COUNT = 20
const MAX_PI_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024

const PI_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

export async function readPiImage(path: string, openImpl: typeof open = open): Promise<Buffer> {
  const file = await openImpl(path, 'r')
  try {
    const invalidImage = (): Error =>
      new Error(`Pi image must be a non-empty file no larger than ${MAX_PI_IMAGE_BYTES} bytes`)
    const info = await file.stat()
    if (!info.isFile()) {
      throw new Error('Pi image must be a file')
    }
    if (info.size > MAX_PI_IMAGE_BYTES) {
      throw invalidImage()
    }
    const buffer = Buffer.allocUnsafe(info.size + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) {
        break
      }
      bytesRead += result.bytesRead
    }
    const finalInfo = await file.stat()
    if (bytesRead === 0 || bytesRead > MAX_PI_IMAGE_BYTES || finalInfo.size !== bytesRead) {
      throw invalidImage()
    }
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

export type PiDispatchContent = {
  text: string
  images: { data: string; mimeType: string }[]
}

/** Split a user message into prompt text plus bounded base64 image payloads. */
export async function collectPiDispatchContent(
  body: AgentJournalMessageItem
): Promise<PiDispatchContent> {
  const text = extractPiDispatchText(body)
  const images: { data: string; mimeType: string }[] = []
  let localBytes = 0
  let count = 0
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type !== 'image-ref') {
      continue
    }
    count += 1
    if (count > MAX_PI_IMAGE_COUNT) {
      throw new Error(`Pi messages support at most ${MAX_PI_IMAGE_COUNT} images`)
    }
    if (block.url) {
      throw new Error('Pi image URLs are unsupported (attach a local file)')
    }
    if (!block.path) {
      throw new Error('image reference has neither a path nor a URL')
    }
    const data = await readPiImage(block.path)
    localBytes += data.byteLength
    if (localBytes > MAX_PI_TOTAL_IMAGE_BYTES) {
      throw new Error(`Pi images must total no more than ${MAX_PI_TOTAL_IMAGE_BYTES} bytes`)
    }
    const mimeType = PI_IMAGE_MIME_BY_EXTENSION[extname(block.path).toLowerCase()]
    if (!mimeType) {
      throw new Error(`Pi does not support the image type ${extname(block.path)}`)
    }
    images.push({ data: data.toString('base64'), mimeType })
  }
  return { text, images }
}
