// Pi-family structured backend slot (SNC1.9).
// Transport-neutral contract for one Pi-family RPC child (`pi --mode rpc` or
// `omp --mode rpc` per session, cwd = acquire workspaceRoot). Production fills
// this with the Orca-owned Pi-family backend (`pi-rpc-backend`); tests inject fakes.

import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { PiFamilySettledEvent } from './pi-family-flavor'
import type { PiFamilyProvider } from './rpc/pi-family-rpc-types'
import type { PiFamilyPromptFact } from './translation/pi-family-record-dialect'
import { piProcessIdentity } from './pi-structured-owner-identity'

export type PiStructuredAcquireResult = {
  piSessionId: string
  leafId: string | null
  pid: number | undefined
  sessionFilePath?: string | null
  model?: string
  thinkingLevel?: string
}

export type PiStructuredDispatchResult =
  | { status: 'accepted' }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; reason: string }

export type PiStructuredBackend = {
  acquire(input: {
    orcaSessionId: string
    workspaceRoot: string
    provider?: PiFamilyProvider
    resumePiSessionId?: string
    resumeSessionFile?: string
    options?: Readonly<Record<string, string>>
    spawnToken: string
    sink?: StructuredAgentSessionEventSink | null
    /** Per-session provider-record observer for dispatch settlement (PIF-4, #25). */
    onRecord?: (record: Record<string, unknown>) => void
  }): Promise<PiStructuredAcquireResult>
  /** Durable history for settlement matching; entries stay provider-native. */
  readEntries?(input: {
    orcaSessionId: string
    since?: string
  }): Promise<{ entries: readonly unknown[]; leafId: string }>
  dispatch(input: {
    orcaSessionId: string
    body: AgentJournalMessageItem
  }): Promise<PiStructuredDispatchResult>
  /**
   * Abort exactly the turn named by `expectedTurnId` (PIF-6, #27).
   * A mismatch sends no provider abort and claims nothing.
   */
  cancel(input: { orcaSessionId: string; expectedTurnId?: string }): Promise<{
    cancelled: boolean
  }>
  /** Adapter-local live turn for the cancellation guard, if the backend tracks one. */
  liveTurnId?(input: { orcaSessionId: string }): string | null
  /** Owning op for one journaled prompt key, or null when it is not answerable. */
  promptOwner?(input: { orcaSessionId: string; itemKey: string }): {
    requestId: string
    opId: string
  } | null
  /** Narrow #25 seam: prompt/catalog facts observed since the last drain. */
  drainPromptFacts?(input: { orcaSessionId: string }): PiFamilyPromptFact[]
  // Returns true only after the Pi child exit AND descendant cleanup are proven.
  // Throws when the root exit was observed but descendants stay unverified.
  close(input: { orcaSessionId: string }): Promise<boolean>
  sessionFilePath?(input: { orcaSessionId: string }): Promise<string | null>
  /**
   * Answer one journaled prompt exactly once (PIF-6, #27). Scoped to the
   * owning session so a stale generation can never answer through a
   * replacement child. Unknown/answered/retired keys throw
   * `UNKNOWN_REQUEST` without touching the provider.
   */
  answerPrompt?(input: {
    orcaSessionId: string
    itemKey: string
    kind: 'approval' | 'question'
    optionId: string
  }): Promise<void>
  setOption?(input: {
    orcaSessionId: string
    key: string
    value: string
  }): Promise<Record<string, string>>
  readOptions?(input: { orcaSessionId: string }): Promise<{
    options: Record<string, string>
    model: string | undefined
    thinkingLevel: string | undefined
  }>
  listModels?(input: { orcaSessionId: string }): Promise<{ id: string; provider: string }[]>
  listThinkingLevels?(input: { orcaSessionId: string }): Promise<string[]>
  readCommands?(input: { orcaSessionId: string }): AgentSessionSlashCommand[] | undefined
  refreshCommands?(input: {
    orcaSessionId: string
  }): Promise<AgentSessionSlashCommand[] | undefined>
  compact?(input: { orcaSessionId: string }): Promise<{ error?: string }>
  readResumeHistory?(input: { orcaSessionId: string }): Promise<{
    rows: { id: string; role: string; text: string }[]
    leafId: string
  }>
}

export function extractPiDispatchText(body: AgentJournalMessageItem): string {
  const parts: string[] = []
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

export function hasPiImageBlocks(body: AgentJournalMessageItem): boolean {
  return (body.blocks as NativeChatBlock[]).some((block) => block.type === 'image-ref')
}

export type PiStructuredSessionAdapterDeps = {
  resolveWorkspacePath: (workspaceId: string) => Promise<string> | string
  readProcessStartTime?: (pid: number) => Promise<number | null> | number | null
  now?: () => number
  backend?: PiStructuredBackend
  hostId?: string
  /** Publishes adapter lifecycle events (unexpected exits) to the host. */
  onEvent?: (event: StructuredAgentSessionLifecycleEvent) => void
  /** History-proven late dispatch settlement, mirroring the Codex/Claude path. */
  onDispatchSettledLate?: (input: {
    sessionId: string
    clientMessageId: string
    providerIdentity: AgentJournalItemIdentity
  }) => void
}

export type PiSession = {
  orcaSessionId: string
  /** Durable Pi-family discriminant this session was acquired under; never inferred. */
  provider: 'pi' | 'omp'
  piSessionId: string
  leafId: string | null
  fence: number
  generation: string
  process: AgentSessionProcessIdentity
  sessionFilePath: string | null
  sink: StructuredAgentSessionEventSink | null
  closed: boolean
  /** Provider-specific final-settle predicate for this live child (PIF-3, #24). */
  isSettledEvent: (event: PiFamilySettledEvent) => boolean
}

/** Pi-family resume target parsed from the journal's opaque provider handle
 *  (`pi:<sessionId>` or `omp:<sessionId>`). The provider travels with the id so
 *  acquisition can refuse a cross-provider resume instead of mis-attributing it. */
export function opaquePiFamilyResume(
  identity: AgentSessionJournalIdentity
): { sessionId: string; provider: 'pi' | 'omp' } | null {
  const handle = identity.providerHandle
  if (!handle || typeof handle !== 'object') {
    return null
  }
  if (handle.kind !== 'opaque') {
    return null
  }
  const value = handle.value
  if (typeof value !== 'string') {
    return null
  }
  for (const provider of ['pi', 'omp'] as const) {
    const rest = value.startsWith(`${provider}:`) ? value.slice(provider.length + 1) : ''
    if (rest.trim() !== '') {
      return { sessionId: rest, provider }
    }
  }
  return null
}

export async function resolvePiProcessIdentity(input: {
  identity: AgentSessionJournalIdentity
  spawnToken: string
  pid: number | undefined
  readProcessStartTime?: (pid: number) => Promise<number | null> | number | null
}): Promise<AgentSessionProcessIdentity> {
  if (input.pid === undefined) {
    throw new Error('pi rpc child started without a pid')
  }
  const reader =
    input.readProcessStartTime !== undefined
      ? async (pid: number) => (await input.readProcessStartTime?.(pid)) ?? null
      : undefined
  if (reader) {
    return piProcessIdentity(
      { identity: input.identity, spawnToken: input.spawnToken, pid: input.pid },
      reader
    )
  }
  return piProcessIdentity({
    identity: input.identity,
    spawnToken: input.spawnToken,
    pid: input.pid
  })
}
