// Orca-owned Pi-family RPC transport types (PIF-2, 44madfire/orca#23).
//
// Protocol revisions consulted:
// - Pi: `pi --mode rpc` LF-only JSONL as vendored from 44madfire/orca-pi
//   `packages/pi-rpc` (MIT) and validated against real Pi 0.84.4 (see
//   `pi-jsonl-framing.ts`); production smoke-probed read-only in
//   `pi-rpc-backend.ts`.
// - OMP: canonical can1357/oh-my-pi at merge `6f2233877756b5553ce520756dd90315d2ff6ee3`
//   (upstream PR #12900, merged 2026-09-23): `docs/rpc.md` plus
//   `packages/coding-agent/src/modes/rpc/{rpc-types,rpc-frame,rpc-mode,rpc-compat,rpc-client}.ts`.
//   The shared history/tree/thinking commands are upstream there, not fork extensions.
//
// This file is transport plumbing: wire shapes and inventories only. It owns
// no session, journal, settlement, or lifecycle semantics.

import type { PiServerEvent } from './pi-wire-protocol'

/** Provider discriminant; part of durable provider identity, never inferred. */
export type PiFamilyProvider = 'pi' | 'omp'

/** OMP startup advertisement (`docs/rpc.md`: ready frame, protocol v1). */
export type OmpReadyFrame = {
  readonly type: 'ready'
  readonly protocolVersion: number
  readonly supportedProtocolVersions: readonly number[]
  readonly maxFrameBytes: number
  readonly maxReassembledFrameBytes: number
}

export function isOmpReadyFrame(value: unknown): value is OmpReadyFrame {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'ready' &&
    'protocolVersion' in value &&
    typeof value.protocolVersion === 'number' &&
    'supportedProtocolVersions' in value &&
    Array.isArray(value.supportedProtocolVersions)
  )
}

/** OMP protocol-v2 chunk carrier (`docs/rpc.md`: `rpc_chunk` frames). */
export type OmpChunkFrame = {
  readonly type: 'rpc_chunk'
  readonly chunkId: string
  readonly index: number
  readonly count: number
  readonly byteLength: number
  readonly data: string
}

export function isOmpChunkFrame(value: unknown): value is OmpChunkFrame {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'rpc_chunk' &&
    'chunkId' in value &&
    typeof value.chunkId === 'string'
  )
}

/** Negotiated protocol version observed by the transport (1 until v2 wins). */
export type PiFamilyProtocolVersion = 1 | 2

/** Ready advertisement retained from the child (first frame wins). */
export type PiFamilyReadyInfo = {
  readonly provider: PiFamilyProvider
  readonly protocolVersion: number
  readonly supportedProtocolVersions: readonly number[]
  readonly maxFrameBytes: number
  readonly maxReassembledFrameBytes: number
}

export function readyInfoOf(provider: PiFamilyProvider, frame: OmpReadyFrame): PiFamilyReadyInfo {
  return {
    provider,
    protocolVersion: frame.protocolVersion,
    supportedProtocolVersions: [...frame.supportedProtocolVersions],
    maxFrameBytes: frame.maxFrameBytes,
    maxReassembledFrameBytes: frame.maxReassembledFrameBytes
  }
}

/**
 * Commands both providers serve under the contract Orca needs. Typed
 * wrappers already live in `pi-rpc-connection-commands.ts`; this inventory
 * is the sharing boundary, not a second client.
 */
export const PI_FAMILY_SHARED_COMMANDS: readonly string[] = [
  'get_state',
  'prompt',
  'abort',
  'get_entries',
  'get_tree',
  'switch_session',
  'get_available_models',
  'set_model',
  'get_available_thinking_levels',
  'set_thinking_level',
  'set_auto_compaction',
  'compact',
  'extension_ui_response'
] as const

/** Pi-only control surface; normalization belongs to #28, not the transport. */
export const PI_FAMILY_PI_ONLY_COMMANDS: readonly string[] = ['get_commands'] as const

/** OMP-only control/protocol surface; stays a dialect, never aliased. */
export const PI_FAMILY_OMP_ONLY_COMMANDS: readonly string[] = [
  'get_available_commands',
  'negotiate_protocol',
  'set_host_tools',
  'set_host_uri_schemes',
  'set_subagent_subscription',
  'get_subagents',
  'abort_and_prompt'
] as const

/**
 * Async server records the transport forwards untouched to subscribers.
 * Shared streaming/history frames flow here; OMP extras (command updates,
 * host tools/URI, subagent frames, notices, `prompt_result`, unknown future
 * records) stay observable and ignorable. Terminal settlement differs
 * (`agent_settled` vs `agent_end` with `isTerminal !== false`) and belongs
 * to the lifecycle dialect, never to this transport.
 */
export type PiFamilyServerRecord = PiServerEvent | OmpReadyFrame

/** OMP async frames tolerated without interpretation (see `docs/rpc.md`). */
export const PI_FAMILY_OMP_TOLERATED_EVENTS: readonly string[] = [
  'ready',
  'rpc_chunk',
  'available_commands_update',
  'prompt_result',
  'host_tool_call',
  'host_tool_cancel',
  'host_tool_update',
  'host_tool_result',
  'host_uri_request',
  'host_uri_cancel',
  'host_uri_result',
  'subagent_lifecycle',
  'subagent_progress',
  'subagent_event',
  'command_output',
  'session_info_update',
  'config_update',
  'extension_error'
] as const
