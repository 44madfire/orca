// External structured-session adapter (SNC1.3 dev seam, provider-neutral).
//
// Implements Orca's current `StructuredAgentSessionAdapter` contract by
// delegating transport to the vendored `BridgeHost` and translating opaque
// `session_event` records into Orca journal appends + Native Chat renders.
//
// Orca remains authoritative for journal, lease/fencing, outbox/idempotency,
// rendering, and client synchronization. The bridge never creates a second
// competing state machine: it only answers "did the provider take this?"
// with honest accepted/rejected/unknown (unknown never triggers resend).
//
// Development-only: enabled via `--enable-external-structured-bridge` plus
// `ORCA_PI_BRIDGE_COMMAND` (see `external-structured-bridge-config.ts`).
// Missing/incompatible bridge fails closed to the ordinary Pi TUI path.
// Pi assumptions stay in `orca-pi`; this file knows only the generic bridge.

import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session-provider-handle'
import type { AgentSessionProcessIdentity } from '../../../../shared/agent-session-record'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import {
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError,
  type AgentSessionDispatchOutcome,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionSetOptionInput
} from '../structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../structured-agent-session-event-sink'
import { BridgeHost, type SessionEventEnvelope } from './bridge-host'
import { externalProviderHandleLink } from './external-structured-owner-identity'
import type { BridgeProviderEvent, BridgeSessionOptions } from './bridge-protocol'
import {
  EXTERNAL_BRIDGE_COMMAND_ENV,
  readExternalBridgeConfig
} from './external-structured-bridge-config'

/** Agent string used for journal identities. Provider-neutral on purpose. */
export const EXTERNAL_BRIDGE_AGENT = 'external'

/** Spawn-token env echoed by the bridge child so the owner probe stays pid-reuse-safe. */
export const EXTERNAL_BRIDGE_SPAWN_TOKEN_ENV = 'ORCA_AGENT_SESSION_SPAWN_TOKEN'

/** Option keys the generic seam accepts (provider-neutral subset). */
const EXTERNAL_OPTION_KEYS = new Set(['model', 'thinkingLevel', 'queueMode', 'autoCompaction'])

// SNC1.6 image budgets (same proven values as the Claude lane; provider-neutral
// caps so one dispatch cannot blow the JSONL frame or the provider payload).
const MAX_EXTERNAL_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_EXTERNAL_IMAGE_COUNT = 20
const MAX_EXTERNAL_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024

const EXTERNAL_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

export type ExternalBridgeHostLike = Pick<
  BridgeHost,
  | 'probeSupport'
  | 'acquire'
  | 'release'
  | 'dispatch'
  | 'cancel'
  | 'answerPrompt'
  | 'setOptions'
  | 'getSession'
  | 'dispose'
  | 'onSessionEvent'
  | 'onLifecycle'
  | 'support'
> & { providerPid?: number | null }

export type ExternalAdapterDeps = {
  resolveWorkspacePath: (workspaceId: string) => Promise<string> | string
  readProcessStartTime?: (pid: number) => Promise<number | null> | number | null
  now?: () => number
  /** Authorized attachment bytes (tests supply fakes; production reads the file). */
  readImageFile?: (path: string) => Promise<Buffer> | Buffer
  /** Injectable host factory (tests supply fakes; production uses BridgeHost). */
  createHost?: (options: {
    bridgeCommand: string
    bridgeArgs: string[]
    workspaceRoot: string
    env?: NodeJS.ProcessEnv
  }) => ExternalBridgeHostLike
  env?: NodeJS.ProcessEnv
  argv?: readonly string[]
  hostVersion?: string
}

type TurnBuffer = {
  sessionId: string
  textByIndex: Map<number, string>
  thinkingByIndex: Map<number, string>
  tools: Map<string, { name: string; output: string; done: boolean; isError: boolean }>
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function boundedPayload(text: string): {
  head: string
  byteLength: number
  digest: string
  truncated: boolean
} {
  const byteLength = Buffer.byteLength(text, 'utf8')
  return { head: text, byteLength, digest: sha256Hex(text), truncated: false }
}

function extractText(body: AgentJournalMessageItem): string {
  const parts: string[] = []
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n')
}

function imageRefsOf(
  body: AgentJournalMessageItem
): Extract<NativeChatBlock, { type: 'image-ref' }>[] {
  return (body.blocks as NativeChatBlock[]).filter(
    (block): block is Extract<NativeChatBlock, { type: 'image-ref' }> => block.type === 'image-ref'
  )
}

function mimeTypeForImagePath(path: string): string | null {
  const map: Record<string, string> = EXTERNAL_IMAGE_MIME_BY_EXTENSION
  return map[extname(path).toLowerCase()] ?? null
}

function optionsFromRecord(options?: Readonly<Record<string, string>>): BridgeSessionOptions {
  if (!options) return {}
  const out: BridgeSessionOptions = {}
  if (typeof options['model'] === 'string' && options['model'] !== '') out.model = options['model']
  if (typeof options['thinkingLevel'] === 'string' && options['thinkingLevel'] !== '')
    out.thinkingLevel = options['thinkingLevel']
  const queue = options['queueMode']
  if (queue === 'reject' || queue === 'steer' || queue === 'followUp') out.queueMode = queue
  const auto = options['autoCompaction']
  if (auto === 'true') out.autoCompaction = true
  else if (auto === 'false') out.autoCompaction = false
  return out
}

export class ExternalStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly hosts = new Map<string, ExternalBridgeHostLike>()
  private readonly sinks = new Map<string, StructuredAgentSessionEventSink>()
  private readonly bridgeSessionByOrca = new Map<string, string>()
  private readonly orcaSessionByBridge = new Map<string, string>()
  private readonly opSession = new Map<string, string>()
  private readonly turns = new Map<string, TurnBuffer>()
  private readonly promptRequestByItemId = new Map<
    string,
    { sessionId: string; requestId: string }
  >()
  private readonly sessionOptions = new Map<string, BridgeSessionOptions>()
  private readonly optionRestoreFailures = new Map<string, Set<string>>()
  private readonly generations = new Map<string, string>()

  constructor(private readonly deps: ExternalAdapterDeps) {}

  supportsCreate = (_location: unknown, agent: string): boolean => {
    const config = readExternalBridgeConfig(this.deps.env, this.deps.argv)
    if (!config.enabled || config.command === '') return false
    return agent === EXTERNAL_BRIDGE_AGENT
  }

  supportsLocation = (_location: unknown): boolean => {
    const config = readExternalBridgeConfig(this.deps.env, this.deps.argv)
    return config.enabled && config.command !== ''
  }

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<{
    process: AgentSessionProcessIdentity
    link: AgentSessionProviderHandleLink
    acquisitionGeneration?: string
  }> {
    const config = readExternalBridgeConfig(this.deps.env, this.deps.argv)
    if (!config.enabled || config.command === '') {
      throw new AgentSessionAcquisitionRefusal(
        `external structured bridge not configured (set ${EXTERNAL_BRIDGE_COMMAND_ENV} + dev flag)`
      )
    }
    const orcaSessionId = input.identity.sessionId
    const workspaceRoot = await this.deps.resolveWorkspacePath(input.identity.workspaceId)
    const createHost =
      this.deps.createHost ??
      ((options: {
        bridgeCommand: string
        bridgeArgs: string[]
        workspaceRoot: string
        env?: NodeJS.ProcessEnv
      }) =>
        new BridgeHost({
          bridgeCommand: options.bridgeCommand,
          bridgeArgs: options.bridgeArgs,
          workspaceRoot: options.workspaceRoot,
          ...(options.env ? { env: options.env } : {}),
          ...(this.deps.hostVersion ? { hostVersion: this.deps.hostVersion } : {})
        }))
    const pathValue = this.deps.env?.['PATH']
    const host = createHost({
      bridgeCommand: config.command,
      bridgeArgs: config.args,
      workspaceRoot,
      env: {
        ...(typeof pathValue === 'string' ? { PATH: pathValue } : {}),
        [EXTERNAL_BRIDGE_SPAWN_TOKEN_ENV]: input.spawnToken
      }
    })
    const support = await host.probeSupport()
    if (!support.available) {
      await host.dispose().catch(() => undefined)
      throw new AgentSessionPreSpawnError(
        `external bridge unavailable: ${support.reason} (fall back to Pi TUI)`
      )
    }
    const requested = optionsFromRecord(input.options)
    const acquired = await host.acquire({ options: requested })
    const bridgeSessionId = acquired.sessionId
    // Fence isolation: a reacquire for the same Orca id starts clean (no option/prompt/op leak).
    if (this.hosts.has(orcaSessionId)) {
      await this.teardown(orcaSessionId).catch(() => undefined)
    }
    this.hosts.set(orcaSessionId, host)
    this.bridgeSessionByOrca.set(orcaSessionId, bridgeSessionId)
    this.orcaSessionByBridge.set(bridgeSessionId, orcaSessionId)
    const initialOptions: BridgeSessionOptions = {}
    if (acquired.metadata.model) initialOptions.model = acquired.metadata.model
    else if (requested.model) initialOptions.model = requested.model
    if (acquired.metadata.thinkingLevel)
      initialOptions.thinkingLevel = acquired.metadata.thinkingLevel
    else if (requested.thinkingLevel) initialOptions.thinkingLevel = requested.thinkingLevel
    if (requested.queueMode) initialOptions.queueMode = requested.queueMode
    if (typeof requested.autoCompaction === 'boolean')
      initialOptions.autoCompaction = requested.autoCompaction
    this.sessionOptions.set(orcaSessionId, initialOptions)
    if (input.events) this.sinks.set(orcaSessionId, input.events)
    host.onSessionEvent((envelope) => this.routeSessionEvent(orcaSessionId, envelope))
    host.onLifecycle(({ kind, message }) => {
      // Lifecycle is diagnostic only; journal/lease ownership stays with Orca.
      console.warn(`[external-bridge] ${kind} session=${orcaSessionId} ${message}`)
    })
    const pidCandidate = (host as { providerPid?: unknown }).providerPid
    let resolvedPid: number | null =
      typeof pidCandidate === 'number' ? (pidCandidate as number) : null
    if (resolvedPid === null) {
      const maybeProc = (host as unknown as { proc?: { pid?: unknown } }).proc
      resolvedPid = typeof maybeProc?.pid === 'number' ? (maybeProc.pid as number) : null
    }
    if (resolvedPid === null || !Number.isSafeInteger(resolvedPid) || resolvedPid <= 0) {
      await host.dispose().catch(() => undefined)
      this.hosts.delete(orcaSessionId)
      throw new AgentSessionPreSpawnError('external bridge started without a probeable pid')
    }
    let startTime: number | null = null
    try {
      const read = this.deps.readProcessStartTime?.(resolvedPid)
      // `await` transparently unwraps the sync-or-async probe result.
      if (read !== undefined) startTime = (await read) ?? null
    } catch {
      startTime = null
    }
    const generation = randomUUID()
    this.generations.set(orcaSessionId, generation)
    const now = this.deps.now?.() ?? Date.now()
    const link = externalProviderHandleLink({
      sessionId: bridgeSessionId,
      fence: input.fence,
      observedAt: now
    })
    return {
      process: {
        hostId: input.identity.hostId,
        pid: resolvedPid,
        processStartTimeMs: startTime,
        spawnToken: input.spawnToken
      },
      link,
      acquisitionGeneration: generation
    }
  }

  async releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    return this.teardown(input.sessionId)
  }

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
  }): Promise<AgentSessionDispatchOutcome> {
    const host = this.hosts.get(input.sessionId)
    const bridgeSessionId = this.bridgeSessionByOrca.get(input.sessionId)
    if (!host || !bridgeSessionId) {
      return { state: 'rejected', reason: 'bridge-unavailable: no live external session' }
    }
    const text = extractText(input.body)
    const imageRefs = imageRefsOf(input.body)
    let images: { data: string; mimeType: string }[] | undefined
    if (imageRefs.length > 0) {
      // SNC1.6: authorized attachment image-ref blocks → bridge images[].
      // Only structured blocks (never terminal paste syntax, never raw paths/URLs in text).
      if (imageRefs.length > MAX_EXTERNAL_IMAGE_COUNT) {
        return {
          state: 'rejected',
          reason: `external-bridge-dev: too many images (max ${MAX_EXTERNAL_IMAGE_COUNT})`
        }
      }
      const resolved: { data: string; mimeType: string }[] = []
      let totalBytes = 0
      for (const ref of imageRefs) {
        if (!ref.path) {
          return {
            state: 'rejected',
            reason: 'external-bridge-dev: image URL refs unsupported (attachments only)'
          }
        }
        const mimeType = mimeTypeForImagePath(ref.path)
        if (!mimeType) {
          return {
            state: 'rejected',
            reason: 'external-bridge-dev: unsupported image type (use png/jpg/gif/webp)'
          }
        }
        let bytes: Buffer
        try {
          const reader = this.deps.readImageFile ?? readFile
          bytes = Buffer.from(await reader(ref.path))
        } catch {
          return { state: 'rejected', reason: 'external-bridge-dev: image unreadable' }
        }
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_EXTERNAL_IMAGE_BYTES) {
          return { state: 'rejected', reason: 'external-bridge-dev: image unreadable' }
        }
        totalBytes += bytes.byteLength
        if (totalBytes > MAX_EXTERNAL_TOTAL_IMAGE_BYTES) {
          return { state: 'rejected', reason: 'external-bridge-dev: images exceed total budget' }
        }
        // Opaque base64, no re-encode; never journaled (history stays text-only provider-side).
        resolved.push({ data: bytes.toString('base64'), mimeType })
      }
      images = resolved
    }
    if (text.trim() === '') {
      return { state: 'rejected', reason: 'external-bridge-dev: empty text dispatch' }
    }
    const outcome = await host.dispatch({
      sessionId: bridgeSessionId,
      text,
      ...(images ? { images } : {})
    })
    if (outcome.status === 'accepted') {
      this.opSession.set(outcome.opId, input.sessionId)
      this.turns.set(outcome.opId, {
        sessionId: input.sessionId,
        textByIndex: new Map(),
        thinkingByIndex: new Map(),
        tools: new Map()
      })
      const providerIdentity: AgentJournalItemIdentity = {
        provider: 'legacy',
        agent: EXTERNAL_BRIDGE_AGENT,
        sessionId: input.sessionId,
        recordId: outcome.opId
      }
      return { state: 'accepted', providerIdentity }
    }
    if (outcome.status === 'rejected') {
      return { state: 'rejected', reason: outcome.reason ?? 'bridge-rejected' }
    }
    return { state: 'unknown', reason: outcome.reason ?? 'bridge-unknown (reconcile via history)' }
  }

  async cancelTurn(input: {
    sessionId: string
    turnId: string
    fence: number
  }): Promise<{ cancelled: boolean }> {
    const host = this.hosts.get(input.sessionId)
    const bridgeSessionId = this.bridgeSessionByOrca.get(input.sessionId)
    if (!host || !bridgeSessionId) return { cancelled: false }
    try {
      const result = await host.cancel(bridgeSessionId, input.turnId)
      return { cancelled: !result.settled }
    } catch {
      return { cancelled: false }
    }
  }

  async answerPrompt(input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
    fence: number
  }): Promise<void> {
    const host = this.hosts.get(input.sessionId)
    if (!host) throw new Error(`no live external session ${input.sessionId}`)
    const pending = this.promptRequestByItemId.get(input.itemId)
    if (!pending || pending.sessionId !== input.sessionId) {
      throw new Error(`unknown prompt item ${input.itemId}`)
    }
    await host.answerPrompt(pending.requestId, input.optionId, false)
    this.promptRequestByItemId.delete(input.itemId)
  }

  async setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<void | Readonly<Record<string, string>>> {
    const host = this.hosts.get(input.sessionId)
    const bridgeSessionId = this.bridgeSessionByOrca.get(input.sessionId)
    if (!host || !bridgeSessionId) throw new Error(`no live external session ${input.sessionId}`)
    if (!EXTERNAL_OPTION_KEYS.has(input.key)) {
      throw new Error(`external bridge has no option named ${input.key}`)
    }
    const current = this.sessionOptions.get(input.sessionId) ?? {}
    const next: BridgeSessionOptions = { ...current }
    if (input.key === 'model') next.model = input.value
    else if (input.key === 'thinkingLevel') next.thinkingLevel = input.value
    else if (input.key === 'queueMode') {
      if (input.value !== 'reject' && input.value !== 'steer' && input.value !== 'followUp') {
        this.trackRestoreFailure(input.sessionId, input.key)
        throw new Error(`invalid queueMode ${input.value}`)
      }
      next.queueMode = input.value
    } else if (input.key === 'autoCompaction') {
      if (input.value !== 'true' && input.value !== 'false') {
        this.trackRestoreFailure(input.sessionId, input.key)
        throw new Error(`invalid autoCompaction ${input.value}`)
      }
      next.autoCompaction = input.value === 'true'
    }
    const updated = await host.setOptions(bridgeSessionId, next)
    this.sessionOptions.set(input.sessionId, { ...updated })
    const record: Record<string, string> = {}
    if (updated.model) record['model'] = updated.model
    if (updated.thinkingLevel) record['thinkingLevel'] = updated.thinkingLevel
    if (updated.queueMode) record['queueMode'] = updated.queueMode
    if (typeof updated.autoCompaction === 'boolean')
      record['autoCompaction'] = String(updated.autoCompaction)
    return record
  }

  async readOptions(input: {
    sessionId: string
    fence: number
  }): Promise<AgentSessionOptionsResult> {
    const cached = this.sessionOptions.get(input.sessionId) ?? {}
    // SNC1.6: current comes from provider-confirmed get_session metadata
    // (model/thinkingLevel). Bridge v1 has no dedicated catalog response, so
    // models:[] stays explicitly as the SNC1.8 catalog-seam follow-up — never
    // claim list-complete without it. thinkingLevel rides as `effort`.
    const host = this.hosts.get(input.sessionId)
    const bridgeSessionId = this.bridgeSessionByOrca.get(input.sessionId)
    if (host && bridgeSessionId) {
      try {
        const meta = await host.getSession(bridgeSessionId)
        const next: BridgeSessionOptions = { ...cached }
        if (meta.model) next.model = meta.model
        if (meta.thinkingLevel) next.thinkingLevel = meta.thinkingLevel
        this.sessionOptions.set(input.sessionId, next)
        return {
          models: [],
          current: {
            model: next.model ?? 'external',
            ...(next.thinkingLevel ? { effort: next.thinkingLevel } : {})
          }
        }
      } catch {
        // Transient state-read failure: fall back to last confirmed cache.
      }
    }
    return {
      models: [],
      current: {
        model: cached.model ?? 'external',
        ...(cached.thinkingLevel ? { effort: cached.thinkingLevel } : {})
      }
    }
  }

  readOptionRestoreFailures(sessionId: string): readonly string[] {
    return [...(this.optionRestoreFailures.get(sessionId) ?? [])]
  }

  async historyFilePath(): Promise<string | null> {
    return null
  }

  readCommands(): undefined {
    return undefined
  }

  async closeSession(sessionId: string): Promise<boolean> {
    return this.teardown(sessionId)
  }

  async forceCloseSession(sessionId: string): Promise<boolean> {
    return this.teardown(sessionId)
  }

  async disposeSession(sessionId: string): Promise<boolean> {
    return this.teardown(sessionId)
  }

  async closeAll(): Promise<void> {
    const ids = [...this.hosts.keys()]
    await Promise.all(ids.map((id) => this.teardown(id)))
  }

  private trackRestoreFailure(sessionId: string, key: string): void {
    let set = this.optionRestoreFailures.get(sessionId)
    if (!set) {
      set = new Set()
      this.optionRestoreFailures.set(sessionId, set)
    }
    set.add(key)
  }

  private async teardown(sessionId: string): Promise<boolean> {
    const host = this.hosts.get(sessionId)
    const bridgeSessionId = this.bridgeSessionByOrca.get(sessionId)
    if (!host) return false
    try {
      if (bridgeSessionId) {
        try {
          await host.release(bridgeSessionId)
        } catch {
          // Release is best-effort; dispose still proves child exit.
        }
      }
      await host.dispose()
    } catch {
      return false
    } finally {
      this.hosts.delete(sessionId)
      this.sinks.delete(sessionId)
      const bridgeId = this.bridgeSessionByOrca.get(sessionId)
      if (bridgeId) this.orcaSessionByBridge.delete(bridgeId)
      this.bridgeSessionByOrca.delete(sessionId)
      this.sessionOptions.delete(sessionId)
      this.generations.delete(sessionId)
      for (const [opId, owner] of [...this.opSession.entries()]) {
        if (owner === sessionId) {
          this.opSession.delete(opId)
          this.turns.delete(opId)
        }
      }
      for (const [itemId, pending] of [...this.promptRequestByItemId.entries()]) {
        if (pending.sessionId === sessionId) this.promptRequestByItemId.delete(itemId)
      }
    }
    return true
  }

  private routeSessionEvent(orcaSessionId: string, envelope: SessionEventEnvelope): void {
    const sink = this.sinks.get(orcaSessionId)
    if (!sink) return
    const opId = envelope.opId ?? this.latestOpFor(orcaSessionId)
    const event = envelope.event
    const turnKey = opId ?? `session:${orcaSessionId}`
    let turn = this.turns.get(turnKey)
    if (!turn) {
      turn = {
        sessionId: orcaSessionId,
        textByIndex: new Map(),
        thinkingByIndex: new Map(),
        tools: new Map()
      }
      this.turns.set(turnKey, turn)
    }
    this.applyBridgeEvent({ sink, orcaSessionId, opId: turnKey, turn, event })
  }

  private latestOpFor(sessionId: string): string | undefined {
    let latest: string | undefined
    for (const [opId, owner] of this.opSession.entries()) {
      if (owner === sessionId) latest = opId
    }
    return latest
  }

  private applyBridgeEvent(input: {
    sink: StructuredAgentSessionEventSink
    orcaSessionId: string
    opId: string
    turn: TurnBuffer
    event: BridgeProviderEvent
  }): void {
    const { sink, orcaSessionId, opId, turn, event } = input
    switch (event.type) {
      case 'turn_start': {
        sink.setActivity?.({ turnId: opId, text: '' })
        sink.publish()
        break
      }
      case 'text_start': {
        const index = event.contentIndex ?? 0
        if (!turn.textByIndex.has(index)) turn.textByIndex.set(index, '')
        break
      }
      case 'text_delta': {
        const index = event.contentIndex ?? 0
        const next = (turn.textByIndex.get(index) ?? '') + event.delta
        turn.textByIndex.set(index, next)
        const identity: AgentJournalItemIdentity = {
          provider: 'legacy',
          agent: EXTERNAL_BRIDGE_AGENT,
          sessionId: orcaSessionId,
          recordId: `${opId}-text-${index}`
        }
        const body: AgentJournalItemBody = {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: next }]
        }
        sink.appendItem(identity, body)
        sink.setActivity?.({ turnId: opId, text: next.slice(-280) })
        sink.publish()
        break
      }
      case 'text_end': {
        const index = event.contentIndex ?? 0
        const finalText = event.text ?? turn.textByIndex.get(index) ?? ''
        turn.textByIndex.set(index, finalText)
        const identity: AgentJournalItemIdentity = {
          provider: 'legacy',
          agent: EXTERNAL_BRIDGE_AGENT,
          sessionId: orcaSessionId,
          recordId: `${opId}-text-${index}`
        }
        const body: AgentJournalItemBody = {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: finalText }]
        }
        sink.appendItem(identity, body)
        sink.publish()
        break
      }
      case 'thinking_start': {
        break
      }
      case 'thinking_delta': {
        const index = event.contentIndex ?? 0
        const next = (turn.thinkingByIndex.get(index) ?? '') + event.delta
        turn.thinkingByIndex.set(index, next)
        const identity: AgentJournalItemIdentity = {
          provider: 'legacy',
          agent: EXTERNAL_BRIDGE_AGENT,
          sessionId: orcaSessionId,
          recordId: `${opId}-thinking-${index}`
        }
        const body: AgentJournalItemBody = {
          kind: 'message',
          role: 'reasoning',
          blocks: [{ type: 'text', text: next }]
        }
        sink.appendItem(identity, body)
        sink.publish()
        break
      }
      case 'thinking_end': {
        const index = event.contentIndex ?? 0
        const finalText = event.thinking ?? turn.thinkingByIndex.get(index) ?? ''
        turn.thinkingByIndex.set(index, finalText)
        if (finalText === '') break
        const identity: AgentJournalItemIdentity = {
          provider: 'legacy',
          agent: EXTERNAL_BRIDGE_AGENT,
          sessionId: orcaSessionId,
          recordId: `${opId}-thinking-${index}`
        }
        const body: AgentJournalItemBody = {
          kind: 'message',
          role: 'reasoning',
          blocks: [{ type: 'text', text: finalText }]
        }
        sink.appendItem(identity, body)
        sink.publish()
        break
      }
      case 'tool_start': {
        turn.tools.set(event.toolCallId, {
          name: event.toolName,
          output: '',
          done: false,
          isError: false
        })
        const identity: AgentJournalItemIdentity = {
          provider: 'legacy',
          agent: EXTERNAL_BRIDGE_AGENT,
          sessionId: orcaSessionId,
          recordId: `${opId}-tool-${event.toolCallId}`
        }
        const body: AgentJournalItemBody = {
          kind: 'tool-call',
          name: event.toolName,
          input: event.args ?? {},
          state: 'running'
        }
        sink.appendItem(identity, body)
        sink.publish()
        break
      }
      case 'tool_progress': {
        const tool = turn.tools.get(event.toolCallId)
        if (tool) tool.output = event.partialResult
        const identity: AgentJournalItemIdentity = {
          provider: 'legacy',
          agent: EXTERNAL_BRIDGE_AGENT,
          sessionId: orcaSessionId,
          recordId: `${opId}-tool-${event.toolCallId}`
        }
        const body: AgentJournalItemBody = {
          kind: 'tool-call',
          name: tool?.name ?? 'tool',
          input: {},
          state: 'running',
          output: boundedPayload(event.partialResult)
        }
        sink.appendItem(identity, body)
        sink.publish()
        break
      }
      case 'tool_end': {
        const tool = turn.tools.get(event.toolCallId)
        if (tool) {
          tool.output = event.result
          tool.done = true
          tool.isError = event.isError
        }
        const identity: AgentJournalItemIdentity = {
          provider: 'legacy',
          agent: EXTERNAL_BRIDGE_AGENT,
          sessionId: orcaSessionId,
          recordId: `${opId}-tool-${event.toolCallId}`
        }
        const body: AgentJournalItemBody = {
          kind: 'tool-call',
          name: tool?.name ?? 'tool',
          input: {},
          state: event.isError ? 'failed' : 'completed',
          output: boundedPayload(event.result)
        }
        sink.appendItem(identity, body)
        sink.publish()
        break
      }
      case 'prompt_request': {
        const prompt = event.prompt
        let body: AgentJournalItemBody
        if (prompt.kind === 'confirm') {
          body = {
            kind: 'approval',
            title: prompt.title,
            detail: prompt.message,
            options: [
              { id: 'confirm', label: 'Confirm' },
              { id: 'cancel', label: 'Cancel' }
            ],
            resolution: {
              state: 'pending',
              selectedOptionId: null,
              resolvedBy: null,
              resolvedAt: null
            }
          }
        } else if (prompt.kind === 'select') {
          body = {
            kind: 'question',
            question: prompt.title,
            options: prompt.options.map((option) => ({ id: option, label: option })),
            resolution: {
              state: 'pending',
              selectedOptionId: null,
              resolvedBy: null,
              resolvedAt: null
            }
          }
        } else {
          body = {
            kind: 'question',
            question: prompt.title,
            options: [{ id: 'submit', label: 'Submit' }],
            freeTextQuestionId: 'input',
            resolution: {
              state: 'pending',
              selectedOptionId: null,
              resolvedBy: null,
              resolvedAt: null
            }
          }
        }
        const identity: AgentJournalItemIdentity = {
          provider: 'legacy',
          agent: EXTERNAL_BRIDGE_AGENT,
          sessionId: orcaSessionId,
          recordId: `${opId}-prompt-${event.requestId}`
        }
        sink.appendItem(identity, body)
        sink.publish()
        this.promptRequestByItemId.set(agentJournalItemKey(identity), {
          sessionId: orcaSessionId,
          requestId: event.requestId
        })
        break
      }
      case 'turn_end': {
        if (event.stopReason === 'error') {
          const identity: AgentJournalItemIdentity = {
            provider: 'legacy',
            agent: EXTERNAL_BRIDGE_AGENT,
            sessionId: orcaSessionId,
            recordId: `${opId}-error`
          }
          const body: AgentJournalItemBody = {
            kind: 'status',
            text: 'provider dispatch failed'
          }
          sink.appendItem(identity, body)
        }
        sink.publish()
        break
      }
      case 'settled': {
        sink.setActivity?.(null)
        sink.publish()
        break
      }
      case 'error': {
        const identity: AgentJournalItemIdentity = {
          provider: 'legacy',
          agent: EXTERNAL_BRIDGE_AGENT,
          sessionId: orcaSessionId,
          recordId: `${opId}-bridge-error`
        }
        const body: AgentJournalItemBody = { kind: 'status', text: 'provider dispatch failed' }
        sink.appendItem(identity, body)
        sink.publish()
        break
      }
    }
  }
}
