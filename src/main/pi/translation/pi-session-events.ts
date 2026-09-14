// Orca-native Pi session events (SNC1.9).
//
// The wire shapes mirror 44madfire/orca-pi's bridge `BridgeProviderEvent`
// (same cases and fields) but are owned here so Orca core never imports the
// external bridge protocol: the SNC1.3 dev seam stays provider-neutral and
// Pi assumptions live only under `src/main/pi/`. Field semantics match
// `packages/structured-bridge/src/protocol.ts`; see `pi-record-mapping.ts`.

export type PiSessionEvent =
  | { type: 'turn_start' }
  | { type: 'text_start'; contentIndex?: number }
  | { type: 'text_delta'; delta: string; contentIndex?: number }
  | { type: 'text_end'; contentIndex?: number; text?: string }
  | { type: 'thinking_start'; contentIndex?: number }
  | { type: 'thinking_delta'; delta: string; contentIndex?: number }
  | { type: 'thinking_end'; contentIndex?: number; thinking?: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args?: unknown }
  | { type: 'tool_progress'; toolCallId: string; partialResult: string }
  | { type: 'tool_end'; toolCallId: string; result: string; isError: boolean }
  | { type: 'turn_end'; stopReason: 'stop' | 'aborted' | 'error'; errorMessage?: string }
  | { type: 'settled'; willRetry?: boolean }
  | {
      type: 'prompt_request'
      requestId: string
      prompt:
        | { kind: 'select'; title: string; options: string[] }
        | { kind: 'confirm'; title: string; message: string }
        | { kind: 'input'; title: string; placeholder?: string }
        | { kind: 'editor'; title: string; prefill?: string }
      timeoutMs?: number
    }
  | { type: 'error'; code: string; message: string }

/** One reconstructed history row (root → leaf order, text only, never bytes). */
export type PiHistoryRow = {
  id: string
  parentId?: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  text?: string
  timestamp: string
}

/** Image attachment for Pi `prompt` (base64 opaque, never logged). */
export type PiPromptImage = {
  data: string
  mimeType: string
}

/** Session options the driver applies through live Pi RPC. */
export type PiSessionOptions = {
  model?: string
  thinkingLevel?: string
  queueMode?: 'reject' | 'steer' | 'followUp'
  autoCompaction?: boolean
}
