import { sha256 } from '@noble/hashes/sha256'

// 128 bits of a digest: far past collision range for a strip of tabs, and short enough that the
// stored blob stays small.
const DIGEST_HEX_LENGTH = 32
const ROW_KEY_PREFIX = 'cached:'
// The whole shape, not the prefix: a wire id that merely starts with the prefix is still wire text.
const ROW_KEY = /^cached:[0-9a-f]{32}$/

/**
 * The React key a strip row draws under. A cached preview row and the live row that replaces it
 * on reconnect must share a key, or the swap remounts every row and blinks the strip the cache
 * exists to keep still. The key is a digest because an editor tab's id embeds its absolute file
 * path, and the key is what the cache persists.
 */
export function toMobileSessionTabStripRowKey(tabId: string): string {
  return `${ROW_KEY_PREFIX}${digestHex(tabId)}`
}

export function isMobileSessionTabStripRowKey(value: string): boolean {
  return ROW_KEY.test(value)
}

export function digestHex(value: string): string {
  const digest = sha256(new TextEncoder().encode(value))
  let hex = ''
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex.slice(0, DIGEST_HEX_LENGTH)
}
