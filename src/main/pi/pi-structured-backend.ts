// Pi structured backend slot (SNC1.9).
// Transport-neutral contract for the Pi RPC child (`pi --mode rpc` per session,
// cwd = acquire workspaceRoot). Production fills this with the vendored Pi RPC
// core (SNC1.8, orca-pi owned); tests inject fakes.

import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { piProcessIdentity } from './pi-structured-owner-identity'
import type { PiAcquireCompat } from './pi-structured-compat'

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
    resumePiSessionId?: string
    resumeSessionFile?: string
    options?: Readonly<Record<string, string>>
    spawnToken: string
    sink?: StructuredAgentSessionEventSink | null
    compat?: PiAcquireCompat
  }): Promise<PiStructuredAcquireResult>
  dispatch(input: {
    orcaSessionId: string
    body: AgentJournalMessageItem
  }): Promise<PiStructuredDispatchResult>
  cancel(input: { orcaSessionId: string }): Promise<{ cancelled: boolean }>
  // Returns true only after the Pi child exit AND descendant cleanup are proven.
  // Throws when the root exit was observed but descendants stay unverified.
  close(input: { orcaSessionId: string }): Promise<boolean>
  sessionFilePath?(input: { orcaSessionId: string }): Promise<string | null>
  answerPrompt?(input: {
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
  /** Production demands nonempty version plus capability evidence. */
  requireCompatEvidence?: boolean
  /** Bounded `pi --version` probe result, cached per install. */
  piVersion?: string | null
  /** Capability set production relies on; forwarded on every acquire. */
  requiredCapabilities?: readonly string[]
}

export type PiSession = {
  orcaSessionId: string
  piSessionId: string
  leafId: string | null
  fence: number
  generation: string
  process: AgentSessionProcessIdentity
  sessionFilePath: string | null
  sink: StructuredAgentSessionEventSink | null
  closed: boolean
}

export function opaquePiResumeSessionId(identity: AgentSessionJournalIdentity): string | null {
  const handle = identity.providerHandle
  if (!handle || typeof handle !== 'object') {
    return null
  }
  if (
    (handle as { kind?: string }).kind === 'opaque' &&
    (handle as { agent?: string }).agent === 'pi'
  ) {
    const value = (handle as { value?: unknown }).value
    if (typeof value === 'string' && value.startsWith('pi:') && value.slice(3).trim() !== '') {
      return value.slice(3)
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
