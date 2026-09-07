import {
  MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_IMAGE_ALT_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_IMAGE_REF_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_MESSAGE_BLOCK_LIMIT,
  MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_READ_LIMIT,
  MOBILE_WEB_NATIVE_CHAT_TOOL_NAME_MAX_CHARACTERS
} from '../../../../shared/mobile-web/native-chat-operation-contract'

export const MOBILE_WEB_NATIVE_CHAT_TRUNCATION_MARKER = '\n… (truncated)'
export const MOBILE_WEB_NATIVE_CHAT_OMITTED_BLOCK = {
  type: 'text',
  text: MOBILE_WEB_NATIVE_CHAT_TRUNCATION_MARKER
}

/**
 * Clips host transcript content down to the page's wire bounds.
 *
 * The host sanitizer caps text blocks at 64 KiB and bounds neither block count nor identifier
 * length, but the page's read schema is `.strict()` at 4200 characters, 64 blocks and a 1024
 * character id. The page parses through the tolerant rewrite, which turns each overrun into a
 * different silent loss: an over-long text block is an unclassifiable member of an array of unions
 * and disappears, while an over-long id or an over-count block array fails its message, and
 * `messages` is not a union array, so one bad message fails the whole read with a non-retryable
 * `invalid_message`.
 *
 * Unknown keys and unknown block types pass through untouched: the shell forwards this payload
 * without parsing it, so a field a newer desktop and its own page both understand must survive an
 * older shell in the middle.
 */
export function clipMobileWebNativeChatToPageContract(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return value
  }
  return {
    ...value,
    messages: value.messages.slice(0, MOBILE_WEB_NATIVE_CHAT_READ_LIMIT).map(clipMessage)
  }
}

function clipMessage(value: unknown): unknown {
  if (!isRecord(value)) {
    return value
  }
  return {
    ...value,
    ...clippedIdentifier(value, 'id'),
    ...clippedIdentifier(value, 'turnId'),
    ...(Array.isArray(value.blocks) ? { blocks: clipBlocks(value.blocks) } : {})
  }
}

/** Clipped rather than dropped: losing the message loses history the page cannot ask for again,
 *  and the clip is deterministic, so read and subscribe still agree on the dedup key. */
function clippedIdentifier(message: Record<string, unknown>, key: 'id' | 'turnId') {
  const value = message[key]
  return typeof value === 'string' &&
    value.length > MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS
    ? { [key]: value.slice(0, MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS) }
    : {}
}

function clipBlocks(blocks: unknown[]): unknown[] {
  const clipped = blocks.map(clipBlock)
  return clipped.length <= MOBILE_WEB_NATIVE_CHAT_MESSAGE_BLOCK_LIMIT
    ? clipped
    : [
        ...clipped.slice(0, MOBILE_WEB_NATIVE_CHAT_MESSAGE_BLOCK_LIMIT - 1),
        MOBILE_WEB_NATIVE_CHAT_OMITTED_BLOCK
      ]
}

function clipBlock(value: unknown): unknown {
  if (!isRecord(value)) {
    return value
  }
  if (value.type === 'text' || value.type === 'tool-result') {
    const field = value.type === 'text' ? 'text' : 'output'
    return { ...value, ...clippedProse(value, field) }
  }
  if (value.type === 'tool-call') {
    return { ...value, ...clippedLabel(value, 'name') }
  }
  if (value.type !== 'image-ref') {
    return value
  }
  return {
    ...value,
    ...droppedWhenOverLong(value, 'path', MOBILE_WEB_NATIVE_CHAT_IMAGE_REF_MAX_CHARACTERS),
    ...droppedWhenOverLong(value, 'url', MOBILE_WEB_NATIVE_CHAT_IMAGE_REF_MAX_CHARACTERS),
    ...droppedWhenOverLong(value, 'alt', MOBILE_WEB_NATIVE_CHAT_IMAGE_ALT_MAX_CHARACTERS)
  }
}

/** Displayed content: the reader is told it was cut. */
function clippedProse(block: Record<string, unknown>, key: string) {
  const value = block[key]
  if (
    typeof value !== 'string' ||
    value.length <= MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS
  ) {
    return {}
  }
  const head = value.slice(
    0,
    MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS -
      MOBILE_WEB_NATIVE_CHAT_TRUNCATION_MARKER.length
  )
  return { [key]: `${head}${MOBILE_WEB_NATIVE_CHAT_TRUNCATION_MARKER}` }
}

/** A short label, so a marker inside it would read as part of the name. */
function clippedLabel(block: Record<string, unknown>, key: string) {
  const value = block[key]
  return typeof value === 'string' && value.length > MOBILE_WEB_NATIVE_CHAT_TOOL_NAME_MAX_CHARACTERS
    ? { [key]: value.slice(0, MOBILE_WEB_NATIVE_CHAT_TOOL_NAME_MAX_CHARACTERS) }
    : {}
}

/** A clipped reference is a wrong reference the page would try to resolve; absent renders a
 *  placeholder instead. */
function droppedWhenOverLong(block: Record<string, unknown>, key: string, maximum: number) {
  const value = block[key]
  return typeof value === 'string' && value.length > maximum ? { [key]: undefined } : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
