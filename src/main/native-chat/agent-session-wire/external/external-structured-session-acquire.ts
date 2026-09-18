// Acquisition phase for the external structured-session adapter.
//
// Split from `external-structured-session-adapter` (line budget): dev-flag gating,
// unproven-helper refusal, host creation, probe/acquire, pid proof, and durable link
// minting. Operates on caller-owned maps; event binding and teardown stay with the
// adapter and arrive as callbacks.

import { randomUUID } from 'node:crypto'
import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session-provider-handle'
import type { AgentSessionProcessIdentity } from '../../../../shared/agent-session-record'
import {
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAcquireInput,
} from '../structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../structured-agent-session-event-sink'
import { BridgeHost } from './bridge-host'
import { externalProviderHandleLink } from './external-structured-owner-identity'
import type { BridgeSessionOptions } from './bridge-protocol'
import {
  EXTERNAL_BRIDGE_COMMAND_ENV,
  readExternalBridgeConfig,
} from './external-structured-bridge-config'
import { optionsFromRecord, EXTERNAL_BRIDGE_SPAWN_TOKEN_ENV } from './external-structured-session-payloads'
import type {
  ExternalAdapterDeps,
  ExternalBridgeHostLike,
} from './external-structured-session-types'

export async function acquireExternalStructuredSession(args: {
  deps: ExternalAdapterDeps
  hosts: Map<string, ExternalBridgeHostLike>
  unprovenSessions: Set<string>
  bridgeSessionByOrca: Map<string, string>
  orcaSessionByBridge: Map<string, string>
  sessionOptions: Map<string, BridgeSessionOptions>
  sinks: Map<string, StructuredAgentSessionEventSink>
  generations: Map<string, string>
  teardown: (sessionId: string) => Promise<boolean>
  bindSessionEvents: (host: ExternalBridgeHostLike, orcaSessionId: string) => void
  input: StructuredAgentSessionAcquireInput
}): Promise<{
  process: AgentSessionProcessIdentity
  link: AgentSessionProviderHandleLink
  acquisitionGeneration?: string
}> {
  const {
    deps,
    hosts,
    unprovenSessions,
    bridgeSessionByOrca,
    orcaSessionByBridge,
    sessionOptions,
    sinks,
    generations,
    teardown,
    bindSessionEvents,
    input,
  } = args
  const config = readExternalBridgeConfig(deps.env, deps.argv)
  if (!config.enabled || config.command === '') {
    throw new AgentSessionAcquisitionRefusal(
      `external structured bridge not configured (set ${EXTERNAL_BRIDGE_COMMAND_ENV} + dev flag)`,
    )
  }
  const orcaSessionId = input.identity.sessionId
  if (unprovenSessions.has(orcaSessionId)) {
    // A prior attempt left a possibly-live helper tracked here: settle it
    // before spawning a replacement, and refuse while its exit is
    // unproven (a second helper beside it could double-own the session).
    await teardown(orcaSessionId)
    if (unprovenSessions.has(orcaSessionId)) {
      throw new AgentSessionPreSpawnError(
        'previous external helper exit is unproven; force-close the session before retrying acquire',
      )
    }
  }
  const workspaceRoot = await deps.resolveWorkspacePath(input.identity.workspaceId)
  const createHost =
    deps.createHost ??
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
        ...(deps.hostVersion ? { hostVersion: deps.hostVersion } : {}),
      }))
  const pathValue = deps.env?.['PATH']
  const host = createHost({
    bridgeCommand: config.command,
    bridgeArgs: config.args,
    workspaceRoot,
    env: {
      ...(typeof pathValue === 'string' ? { PATH: pathValue } : {}),
      [EXTERNAL_BRIDGE_SPAWN_TOKEN_ENV]: input.spawnToken,
    },
  })
  // Track the live child from birth: probe already spawns the helper, so
  // every failure below (probe, acquire, pid) settles it through teardown
  // (proven exit or retained-for-retry) instead of leaking an untracked
  // helper that a retry would duplicate.
  hosts.set(orcaSessionId, host)
  const support = await host.probeSupport()
  if (!support.available) {
    await teardown(orcaSessionId)
    throw new AgentSessionPreSpawnError(
      `external bridge unavailable: ${support.reason} (fall back to Pi TUI)`,
    )
  }
  let acquired: {
    sessionId: string
    metadata: { model?: string; thinkingLevel?: string }
  }
  try {
    acquired = await host.acquire({ options: optionsFromRecord(input.options) })
  } catch (error) {
    await teardown(orcaSessionId)
    throw error
  }
  const bridgeSessionId = acquired.sessionId
  bridgeSessionByOrca.set(orcaSessionId, bridgeSessionId)
  orcaSessionByBridge.set(bridgeSessionId, orcaSessionId)
  const initialOptions: BridgeSessionOptions = {}
  if (acquired.metadata.model) {initialOptions.model = acquired.metadata.model}
  if (acquired.metadata.thinkingLevel) {initialOptions.thinkingLevel = acquired.metadata.thinkingLevel}
  sessionOptions.set(orcaSessionId, initialOptions)
  if (input.events) {sinks.set(orcaSessionId, input.events)}
  bindSessionEvents(host, orcaSessionId)
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
    await teardown(orcaSessionId)
    throw new AgentSessionPreSpawnError('external bridge started without a probeable pid')
  }
  let startTime: number | null = null
  try {
    const read = deps.readProcessStartTime?.(resolvedPid)
    // `await` transparently unwraps the sync-or-async probe result.
    if (read !== undefined) {startTime = (await read) ?? null}
  } catch {
    startTime = null
  }
  const generation = randomUUID()
  generations.set(orcaSessionId, generation)
  const now = deps.now?.() ?? Date.now()
  const link = externalProviderHandleLink({
    sessionId: bridgeSessionId,
    fence: input.fence,
    observedAt: now,
  })
  return {
    process: {
      hostId: input.identity.hostId,
      pid: resolvedPid,
      processStartTimeMs: startTime,
      spawnToken: input.spawnToken,
    },
    link,
    acquisitionGeneration: generation,
  }
}
