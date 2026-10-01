// Pi-family restart history sampling for the `providerHistoryWindow` contract (PIF-8, #29).
//
// Runs BEFORE a new child is acquired, so there is usually no live session:
// the sampler spawns an ephemeral same-provider RPC child, switches it to the
// exact durable session file, verifies the session id, reads the needed
// append-history plus the current leaf, and proves the child stopped again.
// The sample is read-only: it never dispatches (never resends), never mints a
// durable handle, and never disturbs the leaf the later resume consumes. When
// a live session already exists the sampler reads through it instead of
// spawning a competing child, and reports the turn in flight.

import { randomUUID } from 'node:crypto'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type {
  ProviderHistoryItem,
  ProviderHistoryWindow
} from '../native-chat/agent-session-journal/journal-submission-reconciler'
import { extractActiveChainAfterAnchor, piFamilyUserEntryToHistoryItem } from './pi-family-history'
import { normalizePiFamilyHistoryEntry } from './pi-family-dispatch'
import type { PiFamilyProvider } from './rpc/pi-family-rpc-types'
import {
  opaquePiFamilyResume,
  type PiSession,
  type PiStructuredSessionAdapterDeps
} from './pi-structured-backend'

export const PI_FAMILY_INCONSISTENT_WINDOW: ProviderHistoryWindow = {
  items: [],
  boundaryConsistent: false,
  turnInFlight: false
}

export type PiFamilyHistoryWindowResult =
  | { ok: true; window: ProviderHistoryWindow; leafId: string }
  | { ok: false; code: string; message: string; window: ProviderHistoryWindow; leafId: string }

/**
 * Build the restart-reconciliation window from one provider sample. Only
 * ACTIVE-chain user entries strictly after the durable anchor become evidence;
 * abandoned siblings never do. A missing/unproven anchor fails closed with an
 * inconsistent boundary (absence then proves nothing); an anchor that IS the
 * current leaf with no newer rows is the proven-empty window.
 */
export function buildPiFamilyHistoryWindow(input: {
  provider: PiFamilyProvider
  providerSessionId: string
  orcaSessionId: string
  /** Durable branch cursor the journal was built from; undefined means unproven. */
  anchorLeafId: string | null | undefined
  /** Append sample: full history, or strictly-after rows when read with `since`. */
  entries: readonly unknown[]
  /** Current provider leaf from the same sample; preserved verbatim. */
  leafId: string
}): PiFamilyHistoryWindowResult {
  const anchor = input.anchorLeafId
  // A positively proven empty session treats the absence as evidence; anything
  // else without a proven start cursor fails closed (absence proves nothing).
  if (anchor === null && input.entries.length === 0) {
    return {
      ok: true,
      window: { items: [], boundaryConsistent: true, turnInFlight: false },
      leafId: input.leafId
    }
  }
  if (anchor === undefined || anchor === null) {
    return {
      ok: false,
      code: 'PI_HISTORY_ANCHOR_UNKNOWN',
      message: 'Pi-family history has no proven start cursor (reconciliation stays unknown)',
      window: PI_FAMILY_INCONSISTENT_WINDOW,
      leafId: input.leafId
    }
  }
  // The cursor is the tip: an empty `since` sample proves nothing new arrived.
  // Rows behind an unchanged tip mean the sample moved under us (fail closed).
  if (anchor === input.leafId) {
    if (input.entries.length === 0) {
      return {
        ok: true,
        window: { items: [], boundaryConsistent: true, turnInFlight: false },
        leafId: input.leafId
      }
    }
    return {
      ok: false,
      code: 'PI_HISTORY_ANCHOR_UNKNOWN',
      message: 'Pi-family history moved during the sample (reconciliation stays unknown)',
      window: PI_FAMILY_INCONSISTENT_WINDOW,
      leafId: input.leafId
    }
  }
  const after = extractActiveChainAfterAnchor({
    entries: input.entries,
    leafId: input.leafId,
    anchor
  })
  if (!after.ok) {
    return {
      ok: false,
      code: after.code,
      message:
        'Pi-family history anchor is not on the active branch (reconciliation stays unknown)',
      window: PI_FAMILY_INCONSISTENT_WINDOW,
      leafId: input.leafId
    }
  }
  const items: ProviderHistoryItem[] = []
  for (const entry of after.chain) {
    if (normalizePiFamilyHistoryEntry(entry)?.role !== 'user') {
      continue
    }
    const item = piFamilyUserEntryToHistoryItem({
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      orcaSessionId: input.orcaSessionId,
      entry
    })
    if (item) {
      items.push(item)
    }
  }
  return {
    ok: true,
    window: { items, boundaryConsistent: true, turnInFlight: false },
    leafId: input.leafId
  }
}

/** Adapter session map plus deps, by reference; the sampler owns no sessions. */
export type PiFamilyHistoryWindowState = {
  sessions: Map<string, PiSession>
  deps: PiStructuredSessionAdapterDeps
}

/** Read-only history sample for restart reconciliation; null means no usable history. */
export async function readPiFamilyProviderHistoryWindow(
  state: PiFamilyHistoryWindowState,
  input: {
    identity: AgentSessionJournalIdentity
    resumeSessionFile?: string
    durableLeafId?: string | null
  }
): Promise<ProviderHistoryWindow | null> {
  // The durable handle carries the provider kind opaquely; the journal agent
  // must agree with it or this sample belongs to another provider's session.
  const resume = opaquePiFamilyResume(input.identity)
  if (!resume || input.identity.agent !== resume.provider) {
    return null
  }
  const live = state.sessions.get(input.identity.sessionId) ?? null
  const session = live && !live.closed ? live : null
  // A missing cursor fails closed before any RPC: absence in an unanchored
  // sample must never read as evidence.
  const anchor = input.durableLeafId !== undefined ? input.durableLeafId : session?.leafId
  if (anchor === undefined) {
    return PI_FAMILY_INCONSISTENT_WINDOW
  }
  const sessionFile = input.resumeSessionFile ?? session?.sessionFilePath ?? null
  const backend = state.deps.backend
  if (!sessionFile || !backend?.readEntries) {
    return null
  }
  if (session) {
    return readLiveWindow(backend, input.identity.sessionId, resume, anchor)
  }
  return sampleEphemeralWindow({
    backend,
    resolveWorkspacePath: state.deps.resolveWorkspacePath,
    workspaceId: input.identity.workspaceId,
    orcaSessionId: input.identity.sessionId,
    provider: resume.provider,
    providerSessionId: resume.sessionId,
    sessionFile,
    anchor
  })
}

async function readLiveWindow(
  backend: NonNullable<PiStructuredSessionAdapterDeps['backend']>,
  orcaSessionId: string,
  resume: { provider: 'pi' | 'omp'; sessionId: string },
  anchor: string | null
): Promise<ProviderHistoryWindow | null> {
  const read = backend.readEntries
  if (!read) {
    return null
  }
  let data: { entries: readonly unknown[]; leafId: string }
  try {
    data = await read({
      orcaSessionId,
      ...(anchor !== null ? { since: anchor } : {})
    })
  } catch {
    return PI_FAMILY_INCONSISTENT_WINDOW
  }
  if (!data || typeof data.leafId !== 'string') {
    return null
  }
  const built = buildPiFamilyHistoryWindow({
    provider: resume.provider,
    providerSessionId: resume.sessionId,
    orcaSessionId,
    anchorLeafId: anchor,
    entries: data.entries,
    leafId: data.leafId
  })
  if (!built.ok) {
    return built.window
  }
  // A live child may still be appending: absence proves nothing yet.
  return { ...built.window, turnInFlight: true }
}

async function sampleEphemeralWindow(input: {
  backend: NonNullable<PiStructuredSessionAdapterDeps['backend']>
  resolveWorkspacePath: PiStructuredSessionAdapterDeps['resolveWorkspacePath']
  workspaceId: string
  orcaSessionId: string
  provider: 'pi' | 'omp'
  providerSessionId: string
  sessionFile: string
  anchor: string | null
}): Promise<ProviderHistoryWindow | null> {
  let workspaceRoot: string
  try {
    workspaceRoot = await input.resolveWorkspacePath(input.workspaceId)
  } catch {
    return null
  }
  if (!workspaceRoot || workspaceRoot.trim() === '') {
    return null
  }
  let acquired: { piSessionId: string }
  try {
    acquired = await input.backend.acquire({
      orcaSessionId: input.orcaSessionId,
      workspaceRoot,
      provider: input.provider,
      resumeSessionFile: input.sessionFile,
      // Ephemeral read-only sample: no lease, no journal, no durable handle.
      spawnToken: randomUUID(),
      sink: null
    })
  } catch {
    return null
  }
  try {
    // Same-provider file, same-provider child, but still the wrong
    // conversation: refuse rather than mis-attribute its history.
    if (acquired.piSessionId !== input.providerSessionId) {
      return null
    }
    const read = input.backend.readEntries
    if (!read) {
      return null
    }
    let data: { entries: readonly unknown[]; leafId: string }
    try {
      data = await read({
        orcaSessionId: input.orcaSessionId,
        ...(input.anchor !== null ? { since: input.anchor } : {})
      })
    } catch {
      return PI_FAMILY_INCONSISTENT_WINDOW
    }
    if (!data || typeof data.leafId !== 'string') {
      return null
    }
    const built = buildPiFamilyHistoryWindow({
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      orcaSessionId: input.orcaSessionId,
      anchorLeafId: input.anchor,
      entries: data.entries,
      leafId: data.leafId
    })
    return built.window
  } finally {
    // Best-effort proven stop; the sample is stable history either way and a
    // later acquire reaps a stray child through its stale-driver path.
    await input.backend.close({ orcaSessionId: input.orcaSessionId }).catch(() => undefined)
  }
}
