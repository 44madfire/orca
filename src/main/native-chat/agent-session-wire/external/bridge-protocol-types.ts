// Wire types for the SNC1.3 external structured-session bridge (provider-neutral).
//
// Split from `bridge-protocol` (line budget): protocol constants, host/provider message
// shapes, and operation-id minting. Validation lives in `bridge-protocol-validation`;
// secret hygiene and error types stay in `bridge-protocol`.

export const BRIDGE_PROTOCOL_VERSION = 1;

/** Explicit dev-only configuration key (never the public plugin manifest). */
export const BRIDGE_DEV_COMMAND_ENV = "ORCA_PI_BRIDGE_COMMAND";

/** Default timeouts (ms). Host options may override. */
export const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_CLOSE_GRACE_MS = 2_000;
export const MAX_STDERR_BYTES = 8_192;

/** Keys that must never appear in any bridge record (either direction). */
export const FORBIDDEN_BRIDGE_KEYS = Object.freeze([
  "env",
  "processEnv",
  "process_env",
  "auth",
  "credentials",
  "apiKey",
  "api_key",
  "apikey",
  "token",
  "refreshToken",
  "refresh_token",
  "bearer",
  "secret",
  "secrets",
  "password",
] as const);

export type ForbiddenBridgeKey = (typeof FORBIDDEN_BRIDGE_KEYS)[number];

/** Host → provider request kinds. */
export type HostToProviderKind =
  | "hello"
  | "acquire"
  | "release"
  | "dispatch"
  | "cancel"
  | "answer_prompt"
  | "set_options"
  | "get_history"
  | "get_session"
  | "close";

/** Provider → host response/event kinds. */
export type ProviderToHostKind =
  | "hello_ok"
  | "hello_error"
  | "acquired"
  | "released"
  | "dispatch_ack"
  | "cancelled"
  | "options_updated"
  | "history"
  | "session"
  | "session_event"
  | "closed"
  | "exiting"
  | "error";

export type BridgeHostIdentity = {
  /** Always `"orca"` for the dev bridge; kept generic for upstreaming. */
  id: string;
  version: string;
  protocol: number;
}

export type BridgeProviderIdentity = {
  /** e.g. `"mock"`, `"pi"`. Provider-neutral: any id is accepted. */
  id: string;
  version: string;
  protocol: number;
}

export type BridgeCapabilities = {
  textStreaming: boolean;
  thinking: boolean;
  tools: boolean;
  images: boolean;
  extensionDialogs: boolean;
  history: boolean;
  options: boolean;
  cancel: boolean;
  resume: boolean;
}

export type BridgeSessionOptions = {
  model?: string;
  thinkingLevel?: string;
  /** Queue policy for dispatches that arrive while a turn is active. */
  queueMode?: "reject" | "steer" | "followUp";
  autoCompaction?: boolean;
}

export type BridgeSessionMetadata = {
  sessionId: string;
  /** Opaque provider-side session id (e.g. Pi `sessionId`); may equal sessionId for mock. */
  providerSessionId?: string;
  workspaceRoot: string;
  model?: string;
  thinkingLevel?: string;
  messageCount: number;
  isStreaming: boolean;
  createdAt: string;
}

export type BridgeHistoryEntry = {
  id: string;
  parentId?: string;
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  timestamp: string;
}

export type BridgeImage = {
  /** Base64 payload (opaque; preserved verbatim). */
  data: string;
  mimeType: string;
}

export type BridgeDispatchMessage = {
  text: string;
  images?: BridgeImage[];
}

/** Streaming / lifecycle events delivered as `session_event` payloads. */
export type BridgeProviderEvent =
  | { type: "turn_start" }
  | { type: "text_start"; contentIndex?: number }
  | { type: "text_delta"; delta: string; contentIndex?: number }
  | { type: "text_end"; contentIndex?: number; text?: string }
  | { type: "thinking_start"; contentIndex?: number }
  | { type: "thinking_delta"; delta: string; contentIndex?: number }
  | { type: "thinking_end"; contentIndex?: number; thinking?: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_progress"; toolCallId: string; partialResult: string }
  | { type: "tool_end"; toolCallId: string; result: string; isError: boolean }
  | { type: "turn_end"; stopReason: "stop" | "aborted" | "error"; errorMessage?: string }
  | { type: "settled"; willRetry?: boolean }
  | {
      type: "prompt_request";
      requestId: string;
      prompt:
        | { kind: "select"; title: string; options: string[] }
        | { kind: "confirm"; title: string; message: string }
        | { kind: "input"; title: string; placeholder?: string }
        | { kind: "editor"; title: string; prefill?: string };
      timeoutMs?: number;
    }
  | { type: "error"; code: string; message: string };


export const H2P_KINDS: ReadonlySet<string> = new Set([
  "hello",
  "acquire",
  "release",
  "dispatch",
  "cancel",
  "answer_prompt",
  "set_options",
  "get_history",
  "get_session",
  "close",
]);

export const P2H_KINDS: ReadonlySet<string> = new Set([
  "hello_ok",
  "hello_error",
  "acquired",
  "released",
  "dispatch_ack",
  "cancelled",
  "options_updated",
  "history",
  "session",
  "session_event",
  "closed",
  "exiting",
  "error",
]);

let opCounter = 0;

/**
 * Create a unique operation id for one h2p request.
 * Unique per host process; echoed by every provider response for that op.
 */
export function createOpId(prefix = "op"): string {
  opCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${opCounter}_${rand}`;
}

/** Reset the op counter (tests only). */
export function __resetOpCounterForTests(): void {
  opCounter = 0;
}
