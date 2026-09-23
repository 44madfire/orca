// Pi-family dispatch admission and history-backed submission settlement (PIF-4, #25).
//
// One dispatch path for Pi and OMP: journal translation up front (rejected
// locally before any RPC write), prompt acknowledgement maps to `admitted`
// (never straight to `accepted`), and admitted submissions settle only from
// durable provider history at the true final boundary. OMP `prompt_result`
// is normalized here, adapter-local, with no second dispatch state machine.
// Ambiguity retains pending semantics for #29; unknown is never resent.

import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../shared/agent-session-journal-types'
import { collectPiDispatchContent } from './pi-dispatch-images'
import type { PiStructuredBackend } from './pi-structured-backend'
import type { PiFamilyDispatchCursor, PiFamilyDispatchTracker } from './pi-family-dispatch-tracker'
import type { PiFamilyProvider } from './rpc/pi-family-rpc-types'

/** Shared Pi-family prompt shape: text plus opaque base64 image payloads. */
export type PiFamilyPromptContent = {
  readonly text: string
  readonly images?: readonly {
    readonly type: 'image'
    readonly data: string
    readonly mimeType: string
  }[]
}

/** Map a journal message into the shared prompt shape; throws before any RPC write. */
export async function translatePiFamilyPromptBody(
  body: AgentJournalMessageItem
): Promise<PiFamilyPromptContent> {
  const content = await collectPiDispatchContent(body)
  return {
    text: content.text,
    ...(content.images.length > 0
      ? {
          images: content.images.map((image) => ({
            type: 'image' as const,
            data: image.data,
            mimeType: image.mimeType
          }))
        }
      : {})
  }
}

/** Secret-safe refusal for translation failures (mirrors the backend pre-write shaping). */
export function sanitizePiFamilyPromptError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /^Pi (image|messages) /.test(message) ||
    message === 'image reference has neither a path nor a URL'
  ) {
    return message
  }
  return 'Pi message could not be represented for dispatch (attach text or a supported local image)'
}

/** OMP `prompt_result` verdict, normalized adapter-local (never a second state machine). */
export type OmpPromptResultVerdict = 'agent-turn' | 'local-only' | 'ignore'

export function interpretOmpPromptResult(record: Record<string, unknown>): OmpPromptResultVerdict {
  if (record['type'] !== 'prompt_result') {
    return 'ignore'
  }
  if (record['agentInvoked'] === false) {
    return 'local-only'
  }
  if (record['agentInvoked'] === true) {
    return 'agent-turn'
  }
  return 'ignore'
}

/** Narrow structural subset the shared settlement algorithm may rely on. */
export type PiFamilyNormalizedEntry = {
  readonly id: string
  readonly parentId: string | null
  readonly type: string
  readonly role: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function historyEntryId(entry: unknown): string | null {
  if (!isRecord(entry)) {
    return null
  }
  const id = entry['id']
  return typeof id === 'string' && id !== '' ? id : null
}

/** Normalize one provider entry without decoding OMP payloads as Pi's exact union. */
export function normalizePiFamilyHistoryEntry(entry: unknown): PiFamilyNormalizedEntry | null {
  if (!isRecord(entry)) {
    return null
  }
  const record = entry
  const id = historyEntryId(entry)
  const type = record['type']
  if (id === null || typeof type !== 'string' || type === '') {
    return null
  }
  const parentRaw = record['parentId']
  const message = record['message']
  const messageRole = isRecord(message) ? message['role'] : undefined
  const topRole = record['role']
  const role =
    typeof messageRole === 'string' ? messageRole : typeof topRole === 'string' ? topRole : null
  return { id, parentId: typeof parentRaw === 'string' ? parentRaw : null, type, role }
}

export type PiFamilySettlingCandidates =
  | { ok: true; candidates: PiFamilyNormalizedEntry[] }
  | { ok: false; reason: 'cursor-unknown' }

/** User entries committed strictly after the pre-dispatch cursor (uniqueness is the proof). */
export function findPiFamilySettlingCandidates(input: {
  entries: readonly unknown[]
  cursor: PiFamilyDispatchCursor
}): PiFamilySettlingCandidates {
  if (input.cursor.status === 'unknown') {
    return { ok: false, reason: 'cursor-unknown' }
  }
  let fresh = input.entries
  if (input.cursor.status === 'known') {
    const leafId = input.cursor.leafId
    const cursorIndex = input.entries.findIndex((entry) => historyEntryId(entry) === leafId)
    if (cursorIndex === -1) {
      return { ok: false, reason: 'cursor-unknown' }
    }
    fresh = input.entries.slice(cursorIndex + 1)
  }
  const candidates: PiFamilyNormalizedEntry[] = []
  for (const entry of fresh) {
    const normalized = normalizePiFamilyHistoryEntry(entry)
    if (normalized !== null && normalized.role === 'user') {
      candidates.push(normalized)
    }
  }
  return { ok: true, candidates }
}

/** Stable provider-native identity (never synthesized from `clientMessageId`). */
export function piFamilySettlementIdentity(input: {
  provider: PiFamilyProvider
  providerSessionId: string
  entryId: string
}): AgentJournalItemIdentity {
  return {
    provider: 'legacy',
    agent: input.provider,
    sessionId: input.providerSessionId,
    recordId: input.entryId
  }
}

export type PiFamilySettlingSession = {
  readonly orcaSessionId: string
  readonly provider: PiFamilyProvider
  readonly piSessionId: string
  readonly generation: string
}

export type PiFamilyHistoryReader = (input: {
  orcaSessionId: string
}) => Promise<{ entries: readonly unknown[]; leafId: string }>

export type PiFamilyLateSettlement = (input: {
  sessionId: string
  clientMessageId: string
  providerIdentity: AgentJournalItemIdentity
}) => void

export type PiFamilyHistorySnapshot = {
  entries: readonly unknown[]
  leafId: string
}

export type PiFamilyDispatchCursorRead = {
  cursor: PiFamilyDispatchCursor
  history: PiFamilyHistorySnapshot | null
}

/** Read the pre-dispatch cursor; failure degrades to unknown (fail closed, never blocks admission). */
export async function readPiFamilyDispatchCursor(
  backend: Pick<PiStructuredBackend, 'readEntries'> | undefined,
  sessionId: string
): Promise<PiFamilyDispatchCursorRead> {
  try {
    const history = await backend?.readEntries?.({ orcaSessionId: sessionId })
    if (!history) {
      return { cursor: { status: 'unknown' }, history: null }
    }
    // Only a positively proven empty history treats all entries as new.
    if (history.entries.length === 0) {
      return { cursor: { status: 'fresh' }, history }
    }
    if (typeof history.leafId !== 'string' || history.leafId === '') {
      return { cursor: { status: 'unknown' }, history }
    }
    return { cursor: { status: 'known', leafId: history.leafId }, history }
  } catch {
    return { cursor: { status: 'unknown' }, history: null }
  }
}

async function readPiFamilyHistoryForSettlement(
  backend: Pick<PiStructuredBackend, 'readEntries'> | undefined,
  orcaSessionId: string
): Promise<PiFamilyHistorySnapshot> {
  const history = await backend?.readEntries?.({ orcaSessionId })
  if (!history) {
    throw new Error('pi history unavailable for dispatch settlement')
  }
  return { entries: history.entries, leafId: history.leafId }
}

/**
 * Attempt settlement for one live session, optionally reusing a pre-read
 * history (no extra RPC). Generation-fenced: a superseded session settles
 * nothing, so a stale boundary cannot mutate replacement dispatch state.
 */
export async function settlePiFamilySessionFromHistory(args: {
  sessions: Map<string, PiFamilySettlingSession & { closed: boolean }>
  tracker: PiFamilyDispatchTracker
  backend: Pick<PiStructuredBackend, 'readEntries'> | undefined
  onSettled: PiFamilyLateSettlement | undefined
  session: PiFamilySettlingSession & { closed: boolean }
  preRead: PiFamilyHistorySnapshot | null | undefined
}): Promise<void> {
  const live = args.sessions.get(args.session.orcaSessionId)
  if (!live || live.closed || live.generation !== args.session.generation) {
    return
  }
  const preRead = args.preRead
  await settlePiFamilyPendingDispatch({
    session: live,
    tracker: args.tracker,
    readEntries:
      preRead === undefined
        ? async (read) => readPiFamilyHistoryForSettlement(args.backend, read.orcaSessionId)
        : async () => {
            if (!preRead) {
              throw new Error('pi history unavailable for dispatch settlement')
            }
            return preRead
          },
    onSettled: args.onSettled
  })
}

/**
 * Settle one admitted submission from durable history. Settles only when
 * exactly one live pending and exactly one new user entry prove each other;
 * every other shape retains pending for #29 reconciliation. Idempotent: the
 * claim removes the pending, so a repeated observation settles nothing.
 */
export async function settlePiFamilyPendingDispatch(args: {
  session: PiFamilySettlingSession
  tracker: PiFamilyDispatchTracker
  readEntries: PiFamilyHistoryReader
  onSettled: PiFamilyLateSettlement | undefined
}): Promise<boolean> {
  const pending = args.tracker.pendingFor(args.session.orcaSessionId)
  const live = pending.filter((entry) => entry.generation === args.session.generation)
  if (live.length !== pending.length) {
    args.tracker.retainOnly(args.session.orcaSessionId, live)
  }
  if (live.length !== 1 || !args.onSettled) {
    return false
  }
  const only = live[0]
  if (!only) {
    return false
  }
  // An unproven cursor fails closed without even reading: absence of proof is
  // never evidence, so a failed pre-dispatch read can never adopt an entry.
  if (only.cursor.status === 'unknown') {
    return false
  }
  let history: { entries: readonly unknown[]; leafId: string }
  try {
    history = await args.readEntries({ orcaSessionId: args.session.orcaSessionId })
  } catch {
    return false
  }
  const match = findPiFamilySettlingCandidates({
    entries: history.entries,
    cursor: only.cursor
  })
  if (!match.ok || match.candidates.length !== 1) {
    return false
  }
  const candidate = match.candidates[0]
  if (!candidate) {
    return false
  }
  const claimed = args.tracker.claim(
    args.session.orcaSessionId,
    only.clientMessageId,
    args.session.generation
  )
  if (!claimed) {
    return false
  }
  args.onSettled({
    sessionId: args.session.orcaSessionId,
    clientMessageId: only.clientMessageId,
    providerIdentity: piFamilySettlementIdentity({
      provider: args.session.provider,
      providerSessionId: args.session.piSessionId,
      entryId: candidate.id
    })
  })
  return true
}
