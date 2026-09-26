// Pi-family durable history: one structural algorithm, narrow entry normalizer (PIF-8, #29).
//
// The topology/cursor contract is SHARED across Pi and OMP (`get_entries(since?)`,
// `get_tree`, stable `id`/`parentId`, current `leafId`, append ordering). The entry
// PAYLOAD union is NOT: Pi uses Pi-native `SessionEntry` variants, OMP uses
// OMP-native variants (different `model_change`/`model_usage` plus extra
// state/audit records). This module owns the shared structural walks plus the
// narrow provider-aware text/role reads Orca requires. Provider entries stay
// `unknown` until narrowed here, so OMP records are never deserialized as
// Pi's exact union and unknown shapes fail closed instead of throwing.

import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { ProviderHistoryItem } from '../native-chat/agent-session-journal/journal-submission-reconciler'
import { normalizePiFamilyHistoryEntry, piFamilySettlementIdentity } from './pi-family-dispatch'
import type { PiFamilyProvider } from './rpc/pi-family-rpc-types'
import {
  extractActiveBranch,
  extractActiveBranchFromTree,
  translatePiBranchToHistory,
  type ActiveBranchResult,
  type PiHistoryEntryLike,
  type PiHistoryTreeNodeLike
} from './translation/pi-branch-history'
import type { PiHistoryRow } from './translation/pi-session-events'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** Structural narrowing for the topology walk; unknown shapes fail closed (null), never throw. */
function asEntryLike(entry: unknown): PiHistoryEntryLike | null {
  if (!isRecord(entry)) {
    return null
  }
  const type = entry['type']
  const id = entry['id']
  if (typeof type !== 'string' || type === '' || typeof id !== 'string' || id === '') {
    return null
  }
  const parentRaw = entry['parentId']
  const timestampRaw = entry['timestamp']
  return {
    type,
    id,
    parentId: typeof parentRaw === 'string' ? parentRaw : null,
    ...(typeof timestampRaw === 'string' && timestampRaw !== '' ? { timestamp: timestampRaw } : {})
  }
}

/** Pi `message.content` text blocks concatenated; thinking/image/toolCall blocks never contribute. */
function piMessageText(message: unknown): string | null {
  if (typeof message === 'string') {
    return message
  }
  if (!isRecord(message)) {
    return null
  }
  const content = message['content']
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    const text = message['text']
    return typeof text === 'string' ? text : null
  }
  let out = ''
  let seen = false
  for (const block of content) {
    if (!isRecord(block)) {
      continue
    }
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      out += block['text']
      seen = true
    }
  }
  return seen ? out : null
}

/**
 * Narrow semantic text read for one provider-native entry. Pi shapes read the
 * message envelope; OMP-native shapes read the top-level `text`. Null means
 * the entry carries no journalable prose (image-only, tool-only, state/audit).
 */
export function extractPiFamilyEntryText(entry: unknown): string | null {
  if (!isRecord(entry)) {
    return null
  }
  const fromMessage = piMessageText(entry['message'])
  if (fromMessage !== null) {
    return fromMessage
  }
  return typeof entry['text'] === 'string' ? entry['text'] : null
}

function timestampOf(entry: PiHistoryEntryLike): string {
  return typeof entry.timestamp === 'string' && entry.timestamp !== ''
    ? entry.timestamp
    : new Date().toISOString()
}

const OMP_TOOL_ROLES: ReadonlySet<string> = new Set([
  'toolResult',
  'tool_result',
  'toolresult',
  'bashExecution',
  'bash_execution',
  'bashexecution'
])

/**
 * OMP branch translation. OMP-native non-message entries (summaries, state and
 * audit records) contribute no rows but keep chain positions: the structural
 * walk passes through them so root → leaf stays intact.
 */
function translateOmpBranchToHistory(branch: readonly PiHistoryEntryLike[]): PiHistoryRow[] {
  const out: PiHistoryRow[] = []
  for (const entry of branch) {
    const normalized = normalizePiFamilyHistoryEntry(entry)
    if (!normalized) {
      continue
    }
    const text = extractPiFamilyEntryText(entry)
    if (normalized.role === 'user') {
      out.push({ id: entry.id, timestamp: timestampOf(entry), role: 'user', text: text ?? '' })
      continue
    }
    if (normalized.role === 'assistant') {
      if (text !== null && text !== '') {
        out.push({ id: entry.id, timestamp: timestampOf(entry), role: 'assistant', text })
      }
      continue
    }
    if (normalized.role !== null && OMP_TOOL_ROLES.has(normalized.role)) {
      out.push({ id: entry.id, timestamp: timestampOf(entry), role: 'tool', text: text ?? '' })
      continue
    }
    if (normalized.role === 'system' && text !== null && text !== '') {
      out.push({ id: entry.id, timestamp: timestampOf(entry), role: 'system', text })
    }
  }
  return out
}

/**
 * Translate an active-branch entry list to resume rows for `provider`. Pi
 * keeps its verbatim mapping (never weakened to fit OMP); OMP applies only
 * the narrow role/text reads above.
 */
export function translatePiFamilyBranchToHistory(
  branch: readonly PiHistoryEntryLike[],
  provider: PiFamilyProvider
): PiHistoryRow[] {
  if (provider === 'omp') {
    return translateOmpBranchToHistory(branch)
  }
  return translatePiBranchToHistory(branch)
}

/**
 * Derive the ACTIVE root → leaf chain. Append-history includes abandoned
 * siblings; the rebuild does not: only entries on the `leafId` parent chain
 * survive. Falls back to `get_tree` nodes when the flat chain is broken.
 */
export function derivePiFamilyActiveChain(input: {
  entries: readonly PiHistoryEntryLike[]
  leafId: string
  tree?: readonly PiHistoryTreeNodeLike[]
}): ActiveBranchResult {
  const flat = extractActiveBranch(input.entries, input.leafId)
  if (flat.ok || flat.code !== 'PI_HISTORY_CHAIN_BROKEN' || !input.tree) {
    return flat
  }
  return extractActiveBranchFromTree(input.tree, input.leafId)
}

export type ActiveChainAfterAnchorResult =
  | { ok: true; chain: unknown[] }
  | {
      ok: false
      code:
        | 'PI_HISTORY_LEAF_MISSING'
        | 'PI_HISTORY_CHAIN_BROKEN'
        | 'PI_HISTORY_CYCLE'
        | 'PI_HISTORY_ANCHOR_UNKNOWN'
    }

/**
 * Active-chain walk terminated by the durable anchor instead of the root.
 * Follows `parentId` from the current leaf and stops at the anchor, so it
 * works on `get_entries(since=anchor)` append-windows (which never contain
 * the anchor itself) as well as on full reads. Entries on abandoned sibling
 * branches are never walked, so they can never become evidence.
 */
function entryId(entry: unknown): string | null {
  if (!isRecord(entry)) {
    return null
  }
  const id = entry['id']
  return typeof id === 'string' && id !== '' ? id : null
}

function entryParentId(entry: unknown): string | null {
  if (!isRecord(entry)) {
    return null
  }
  const parentId = entry['parentId']
  return typeof parentId === 'string' ? parentId : null
}

export function extractActiveChainAfterAnchor(input: {
  entries: readonly unknown[]
  leafId: string
  anchor: string
}): ActiveChainAfterAnchorResult {
  if (!input.leafId) {
    return { ok: false, code: 'PI_HISTORY_LEAF_MISSING' }
  }
  // Originals stay addressable: the walk reads only id/parentId, while role
  // and text normalization below needs the full provider-native payload.
  const byId = new Map<string, unknown>()
  for (const raw of input.entries) {
    const id = entryId(raw)
    if (id && !byId.has(id)) {
      byId.set(id, raw)
    }
  }
  const leaf = byId.get(input.leafId)
  if (leaf === undefined) {
    return { ok: false, code: 'PI_HISTORY_LEAF_MISSING' }
  }
  // The cursor is the tip: strictly-after is empty (the caller proves the
  // empty sample separately; a non-empty one against this tip fails closed).
  if (input.leafId === input.anchor) {
    return { ok: true, chain: [] }
  }
  const reversed: unknown[] = []
  const seen = new Set<string>()
  let current: unknown = leaf
  for (;;) {
    const id = entryId(current)
    if (id === null) {
      return { ok: false, code: 'PI_HISTORY_CHAIN_BROKEN' }
    }
    if (id === input.anchor) {
      break
    }
    if (seen.has(id)) {
      return { ok: false, code: 'PI_HISTORY_CYCLE' }
    }
    seen.add(id)
    reversed.push(current)
    const parentId = entryParentId(current)
    if (parentId === input.anchor) {
      break
    }
    if (parentId === null) {
      return { ok: false, code: 'PI_HISTORY_ANCHOR_UNKNOWN' }
    }
    const parent = byId.get(parentId)
    if (parent === undefined) {
      return { ok: false, code: 'PI_HISTORY_CHAIN_BROKEN' }
    }
    current = parent
    if (reversed.length > byId.size + 1) {
      return { ok: false, code: 'PI_HISTORY_CYCLE' }
    }
  }
  reversed.reverse()
  return { ok: true, chain: reversed }
}

/**
 * Stable submission fingerprint for a provider user entry. Same function the
 * send path runs over the journal body, so a provider entry holding the exact
 * submitted text matches through the GENERIC reconciler by equality, not guess.
 */
export function piFamilyUserEntryFingerprint(orcaSessionId: string, text: string): string {
  return computeAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: orcaSessionId,
    fields: { body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] } }
  })
}

/** One active-chain user entry as restart-reconciliation evidence for the generic reconciler. */
export function piFamilyUserEntryToHistoryItem(input: {
  provider: PiFamilyProvider
  providerSessionId: string
  orcaSessionId: string
  entry: unknown
}): ProviderHistoryItem | null {
  const like = asEntryLike(input.entry)
  if (!like) {
    return null
  }
  const text = extractPiFamilyEntryText(input.entry)
  return {
    providerItemId: like.id,
    // Pi/OMP drop the client message id, so identity matching reduces to the fingerprint pass.
    clientMessageId: null,
    payloadFingerprint:
      text === null ? null : piFamilyUserEntryFingerprint(input.orcaSessionId, text),
    identity: piFamilySettlementIdentity({
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      entryId: like.id
    })
  }
}
