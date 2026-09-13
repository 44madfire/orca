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
import { piProcessIdentity } from './pi-structured-owner-identity'

export type PiStructuredAcquireResult = {
  piSessionId: string
  leafId: string | null
  pid: number | undefined
  sessionFilePath?: string | null
}

export type PiStructuredDispatchResult =
  | { status: 'accepted'; piSessionId: string }
  | { status: 'rejected'; piSessionId: string; reason: string }
  | { status: 'unknown'; piSessionId: string; reason: string }

export type PiStructuredBackend = {
  acquire(input: {
    workspaceRoot: string
    resumePiSessionId?: string
    options?: Readonly<Record<string, string>>
    spawnToken: string
  }): Promise<PiStructuredAcquireResult>
  dispatch(input: {
    piSessionId: string
    text: string
    fence: number
  }): Promise<PiStructuredDispatchResult>
  cancel(input: { piSessionId: string; fence: number }): Promise<{ cancelled: boolean }>
  // Returns true only after the Pi child exit AND descendant cleanup are proven.
  close(input: { piSessionId: string }): Promise<boolean>
  sessionFilePath?(input: { piSessionId: string }): Promise<string | null>
  answerPrompt?(input: { piSessionId: string; requestId: string; optionId: string }): Promise<void>
  setOption?(input: { piSessionId: string; key: string; value: string }): Promise<void>
  readOptions?(input: { piSessionId: string }): Promise<Readonly<Record<string, string>>>
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
  return piProcessIdentity({ identity: input.identity, spawnToken: input.spawnToken, pid: input.pid })
}
