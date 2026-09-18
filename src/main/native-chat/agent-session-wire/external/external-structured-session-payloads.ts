// Journal-payload helpers for the external structured-session adapter.
//
// Split from `external-structured-session-adapter` (line budget): provider-neutral message
// shaping (text/image extraction, option filtering, bounded digests) with no host state.

import { createHash } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import type { BridgeSessionOptions } from './bridge-protocol'

/** Agent string used for journal identities. Provider-neutral on purpose. */
export const EXTERNAL_BRIDGE_AGENT = 'external'

/** Spawn-token env echoed by the bridge child so the owner probe stays pid-reuse-safe. */
export const EXTERNAL_BRIDGE_SPAWN_TOKEN_ENV = 'ORCA_AGENT_SESSION_SPAWN_TOKEN'

export type TurnBuffer = {
  sessionId: string
  textByIndex: Map<number, string>
  thinkingByIndex: Map<number, string>
  tools: Map<string, { name: string; output: string; done: boolean; isError: boolean }>
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function boundedPayload(text: string): {
  head: string
  byteLength: number
  digest: string
  truncated: boolean
} {
  const byteLength = Buffer.byteLength(text, 'utf8')
  return { head: text, byteLength, digest: sha256Hex(text), truncated: false }
}

export function extractText(body: AgentJournalMessageItem): string {
  const parts: string[] = []
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {parts.push(block.text)}
  }
  return parts.join('\n')
}

export function hasImageBlocks(body: AgentJournalMessageItem): boolean {
  return (body.blocks as NativeChatBlock[]).some((block) => block.type === 'image-ref')
}

export function optionsFromRecord(options?: Readonly<Record<string, string>>): BridgeSessionOptions {
  if (!options) {return {}}
  const out: BridgeSessionOptions = {}
  if (typeof options['model'] === 'string' && options['model'] !== '')
    {out.model = options['model']}
  if (typeof options['thinkingLevel'] === 'string' && options['thinkingLevel'] !== '')
    {out.thinkingLevel = options['thinkingLevel']}
  const queue = options['queueMode']
  if (queue === 'reject' || queue === 'steer' || queue === 'followUp') {out.queueMode = queue}
  const auto = options['autoCompaction']
  if (auto === 'true') {out.autoCompaction = true}
  else if (auto === 'false') {out.autoCompaction = false}
  return out
}
