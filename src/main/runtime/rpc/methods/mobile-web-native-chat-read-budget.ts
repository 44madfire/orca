import {
  MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES
} from '../../../../shared/mobile-web/native-chat-operation-contract'

const MARKER = '\n… (truncated)'
const omittedBlock = { type: 'text', text: MARKER }
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

export function boundMobileWebNativeChatRead(value: unknown): unknown {
  if (byteLength(value) <= MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES) {
    return value
  }
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error('too_large')
  }

  // Keep every message and the host cursor: dropping messages would skip history on the next read.
  const metadata = value.messages.map((message) =>
    isRecord(message) && Array.isArray(message.blocks) ? { ...message, blocks: [] } : message
  )
  const remaining =
    MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES - byteLength({ ...value, messages: metadata })
  const allowance = Math.floor(remaining / Math.max(1, metadata.length))
  if (allowance < byteLength([omittedBlock])) {
    throw new Error('too_large')
  }
  return {
    ...value,
    messages: value.messages.map((message) =>
      isRecord(message) && Array.isArray(message.blocks)
        ? { ...message, blocks: boundBlocks(message.blocks, allowance) }
        : message
    )
  }
}

function boundBlocks(blocks: unknown[], allowance: number): unknown[] {
  if (byteLength(blocks) <= allowance) {
    return blocks
  }
  let cap = MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS
  while (cap >= 0) {
    const projected = blocks.map((block) => {
      if (!isRecord(block)) {
        return block
      }
      const field = block.type === 'text' ? 'text' : block.type === 'tool-result' ? 'output' : null
      if (!field || typeof block[field] !== 'string' || block[field].length <= cap) {
        return block
      }
      return { ...block, [field]: block[field].slice(0, cap) + MARKER }
    })
    if (byteLength(projected) <= allowance) {
      return projected
    }
    if (cap === 0) {
      // Oversized tools/future blocks remain visibly truncated, without a closed block schema.
      const bounded: unknown[] = []
      let used = 2 + byteLength(omittedBlock) + 1
      for (const block of projected) {
        const bytes = byteLength(block) + 1
        if (used + bytes > allowance) {
          break
        }
        bounded.push(block)
        used += bytes
      }
      return [...bounded, omittedBlock]
    }
    cap = Math.floor(cap / 2)
  }
  return [omittedBlock]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
