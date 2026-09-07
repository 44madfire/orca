/**
 * The one plain-text rendering of a worker transcript message.
 *
 * The CLI prints `worker-read --source transcript` with it, and `terminal read` serves a structured
 * worker's recent output through it, so a peer sees the same text either way. Shared rather than
 * copied: two renderings would let the two surfaces disagree about what a tool call looked like.
 */

import {
  isSubagentGroupFallbackText,
  subagentGroupFallbackText
} from './native-chat-subagent-summary'
import type { NativeChatMessage } from './native-chat-types'

export function formatWorkerTranscriptMessage(message: NativeChatMessage): string {
  // Every roster block is written beside a plain-text twin carrying the same
  // sentence, for clients that cannot draw the block. Text surfaces are those
  // clients, so they print the twin and drop the block — the mirror of the
  // renderer, which draws the block and drops the twin. Either way the sentence
  // prints once.
  const hasTwin = message.blocks.some(
    (block) => block.type === 'text' && isSubagentGroupFallbackText(block.text)
  )
  const blocks = message.blocks.map((block) => {
    if (block.type === 'text') {
      return block.text
    }
    if (block.type === 'tool-call') {
      return `[tool ${block.name}] ${safeJson(block.input)}`
    }
    if (block.type === 'tool-result') {
      return `[tool result${block.isError ? ' error' : ''}] ${block.output}`
    }
    if (block.type === 'image-ref') {
      return block.url ? `[image] ${block.url}` : `[image omitted]`
    }
    if (block.type === 'subagent-group') {
      // Stand in for the block only when no twin is being printed: the wire
      // admits a roster that arrived without one, and dropping that
      // unconditionally would lose the sentence altogether. Presence, not a
      // byte compare against a recomputed sentence — a roster from a newer
      // build holds a state this build reads as `unverifiable`, so recomputing
      // yields a different sentence and both would print.
      return hasTwin ? null : `[subagents] ${subagentGroupFallbackText(block.agents)}`
    }
    // The journal deliberately admits block types this build does not know, and
    // a newer remote host can send one over the wire. Degrade to a marker rather
    // than reading fields off a shape that has none.
    return '[unsupported block]'
  })
  return `[${message.role}] ${blocks.filter((line) => line !== null).join('\n')}`.trimEnd()
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable input]'
  }
}
