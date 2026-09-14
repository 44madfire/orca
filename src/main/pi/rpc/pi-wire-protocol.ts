// Vendored from 44madfire/orca-pi `packages/pi-rpc/src/protocol.ts` (MIT) for
// SNC1.9 native Pi (see `packages/structured-bridge/docs/native-adapter.md`).
// Orca-side adaptations: none (pure wire types, no imports).
/**
 * Pi RPC protocol types (SNC1.2).
 *
 * Production-quality, Orca-independent view of the `pi --mode rpc` wire
 * proven in SNC1.1 (`docs/pi-rpc-contract.md`, `fixtures/*.jsonl`).
 *
 * This module knows about Pi, not Orca. It must never import Orca
 * journal/session types; `../translation` owns Pi → Native Chat mapping.
 *
 * Forward-compatibility rule: unknown commands/events pass through as
 * `Record<string, unknown>` payloads. Typed wrappers cover the protocol
 * proven in #11; `request()` stays generic so new Pi commands work without
 * a client release.
 */

/** Image attachment for `prompt` (proven in `images.jsonl`). */
export type PiImageAttachment = {
  readonly type: "image";
  /** Base64 bytes (opaque; never logged). */
  readonly data: string;
  readonly mimeType: string;
}

/** `streamingBehavior` for `prompt` while streaming (proven in `abort-queue`). */
export type PiStreamingBehavior = "steer" | "followUp";

/** Queue mode for `set_steering_mode` / `set_follow_up_mode`. */
export type PiQueueMode = "one-at-a-time" | "all";

/** Base shape for every client→server command. */
export type PiCommandBase = {
  readonly id?: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

/** `prompt` — queue a user turn. Success means accepted, not completed. */
export type PiPromptCommand = {
  readonly type: "prompt";
  readonly message: string;
  readonly images?: readonly PiImageAttachment[];
  readonly streamingBehavior?: PiStreamingBehavior;
} & PiCommandBase

/** `steer` / `follow_up` — queue input for before/after the next LLM call. */
export type PiQueueCommand = {
  readonly type: "steer" | "follow_up";
  readonly message: string;
} & PiCommandBase

/** Direct out-of-band execution (proven in `bash-rpc.jsonl`). */
export type PiBashCommand = {
  readonly type: "bash";
  readonly command: string;
} & PiCommandBase

/** Any other command (state, history, models, sessions, …). */
export type PiCommand = PiCommandBase;

/** Wire response (`s2c` with `type: "response"`). */
export type PiResponse = {
  readonly id?: string;
  readonly type: "response";
  /** Echoed command name (`"parse"` for malformed-input rejections). */
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

/** Successful response with typed data. */
export type PiResponseSuccess<T = unknown> = {
  readonly success: true;
  readonly data: T;
} & PiResponse

/** Rejected response (`success: false` + `error`, never `data`). */
export type PiResponseFailure = {
  readonly success: false;
  readonly error: string;
} & PiResponse

export function isPiResponse(value: unknown): value is PiResponse {
  if (!value || typeof value !== "object") {return false;}
  const v = value as Record<string, unknown>;
  return v["type"] === "response" && typeof v["command"] === "string" && typeof v["success"] === "boolean";
}

export function isPiResponseSuccess(value: unknown): value is PiResponseSuccess {
  return isPiResponse(value) && (value as PiResponse).success === true;
}

export function isPiResponseFailure(value: unknown): value is PiResponseFailure {
  return isPiResponse(value) && (value as PiResponse).success === false;
}

// ---------------------------------------------------------------------------
// Shared data shapes (representative, not exhaustive — Pi may add fields).
// ---------------------------------------------------------------------------

/** Provider model entry (redacted catalog view; no costs/urls/tokens here). */
export type PiModel = {
  readonly id: string;
  readonly name?: string;
  readonly api?: string;
  readonly provider: string;
  readonly baseUrl?: string;
  readonly reasoning?: boolean;
  readonly input?: readonly string[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly [key: string]: unknown;
}

/** `get_state` data (proven in `startup-idle` / `state-tree`). */
export type PiState = {
  readonly model?: PiModel;
  readonly thinkingLevel?: string;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly steeringMode?: string;
  readonly followUpMode?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly sessionFile?: string;
  readonly autoCompactionEnabled?: boolean;
  readonly messageCount?: number;
  readonly pendingMessageCount?: number;
  readonly [key: string]: unknown;
}

/** Session journal entry (append-only tree node payload). */
export type PiEntry = {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp?: string;
  readonly [key: string]: unknown;
}

/** `get_tree` node. */
export type PiTreeNode = {
  readonly entry: PiEntry;
  readonly children: readonly PiTreeNode[];
}

/** Chat message (user / assistant / toolResult / bashExecution …). */
export type PiMessage = {
  readonly role: string;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

/** Forkable user turn. */
export type PiForkMessage = {
  readonly entryId: string;
  readonly text: string;
  readonly [key: string]: unknown;
}

/** `get_session_stats` data (`contextUsage` may be omitted). */
export type PiSessionStats = {
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly userMessages?: number;
  readonly assistantMessages?: number;
  readonly toolCalls?: number;
  readonly toolResults?: number;
  readonly totalMessages?: number;
  readonly tokens?: unknown;
  readonly cost?: unknown;
  readonly contextUsage?: unknown;
  readonly [key: string]: unknown;
}

/** `get_commands` entry. */
export type PiCommandInfo = {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
  readonly sourceInfo?: unknown;
  readonly [key: string]: unknown;
}

/** `get_entries` data. */
export type PiEntriesData = {
  readonly entries: readonly PiEntry[];
  readonly leafId: string;
}

/** `get_tree` data. */
export type PiTreeData = {
  readonly tree: readonly PiTreeNode[];
  readonly leafId: string;
}

/** `get_messages` data (active-branch flattened view). */
export type PiMessagesData = {
  readonly messages: readonly PiMessage[];
}

/** `get_last_assistant_text` data — empty `{}` when no assistant text yet. */
export type PiLastAssistantTextData = {
  readonly text?: string | null;
}

/** `clear_queue` data (returns the drained queues). */
export type PiClearQueueData = {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
}

/** `bash` data. */
export type PiBashResult = {
  readonly output: string;
  readonly exitCode: number;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
  readonly [key: string]: unknown;
}

/** `fork` data. */
export type PiForkResult = {
  readonly text: string;
  readonly cancelled: boolean;
  readonly [key: string]: unknown;
}

/** Session-switching results (`switch_session` / `clone` / `new_session`). */
export type PiSessionSwitchResult = {
  readonly cancelled: boolean;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Server→client events (non-response `s2c` records).
// ---------------------------------------------------------------------------

/** Base shape for every async server event. */
export type PiEventBase = {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type PiAgentEndEvent = {
  readonly type: "agent_end";
  readonly messages: readonly PiMessage[];
  readonly willRetry: boolean;
} & PiEventBase

export type PiTurnEndEvent = {
  readonly type: "turn_end";
  readonly message: PiMessage;
  readonly toolResults: readonly PiMessage[];
} & PiEventBase

export type PiMessageStartEvent = {
  readonly type: "message_start";
  readonly message: PiMessage;
} & PiEventBase

export type PiMessageEndEvent = {
  readonly type: "message_end";
  readonly message: PiMessage;
} & PiEventBase

export type PiMessageUpdateEvent = {
  readonly type: "message_update";
  readonly usage?: unknown;
  readonly assistantMessageEvent?: {
    readonly type: string;
    readonly contentIndex?: number;
    readonly delta?: string;
    readonly content?: string;
    readonly id?: string;
    readonly toolName?: string;
    readonly toolCall?: unknown;
    readonly [key: string]: unknown;
  };
} & PiEventBase

export type PiToolExecutionStartEvent = {
  readonly type: "tool_execution_start";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
} & PiEventBase

export type PiToolExecutionUpdateEvent = {
  readonly type: "tool_execution_update";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  /** Accumulated result — replaces display (proven in `tool-execution`). */
  readonly partialResult?: unknown;
} & PiEventBase

export type PiToolExecutionEndEvent = {
  readonly type: "tool_execution_end";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result?: unknown;
  readonly isError?: boolean;
} & PiEventBase

export type PiBashExecutionUpdateEvent = {
  readonly type: "bash_execution_update";
  /** Correlates the originating `bash` command `id`. */
  readonly id: string;
  readonly delta: string;
} & PiEventBase

export type PiQueueUpdateEvent = {
  readonly type: "queue_update";
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
} & PiEventBase

export type PiThinkingLevelChangedEvent = {
  readonly type: "thinking_level_changed";
  readonly level: string;
} & PiEventBase

export type PiSessionInfoChangedEvent = {
  readonly type: "session_info_changed";
  readonly name: string;
} & PiEventBase

export type PiCompactionStartEvent = {
  readonly type: "compaction_start";
  readonly reason: string;
} & PiEventBase

export type PiCompactionEndEvent = {
  readonly type: "compaction_end";
  readonly reason: string;
  readonly aborted: boolean;
  readonly willRetry: boolean;
  readonly errorMessage?: string;
} & PiEventBase

/** Dialog methods proven live (`extension-ui.jsonl`). */
export type PiExtensionUiMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "setTitle"
  | "setStatus"
  | "setWidget"
  | "set_editor_text"
  | (string & {});

/** Server request for extension UI (`s2c`). */
export type PiExtensionUiRequest = {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method: PiExtensionUiMethod;
  readonly title?: string;
  readonly message?: string;
  readonly options?: readonly string[];
  readonly placeholder?: string;
  readonly prefill?: string;
  readonly notifyType?: string;
} & PiEventBase

/** Client reply to an extension UI request (`c2s`, no response expected). */
export type PiExtensionUiResponse = {
  readonly type: "extension_ui_response";
  readonly id: string;
  readonly value?: unknown;
  readonly confirmed?: boolean;
  readonly cancelled?: boolean;
  readonly [key: string]: unknown;
}

/** Any server event (known or forward-compatible unknown). */
export type PiServerEvent = PiEventBase;

/** Any server→client record (response or event). */
export type PiServerMessage = PiResponse | PiServerEvent;

export function isExtensionUiRequest(value: unknown): value is PiExtensionUiRequest {
  if (!value || typeof value !== "object") {return false;}
  const v = value as Record<string, unknown>;
  return v["type"] === "extension_ui_request" && typeof v["id"] === "string";
}

/** Fire-and-forget UI methods never expect a response (safe to ignore). */
const FIRE_AND_FORGET_UI_METHODS: ReadonlySet<string> = new Set([
  "notify",
  "setTitle",
  "setStatus",
  "setWidget",
  "set_editor_text",
]);

export function isExtensionUiFireAndForget(method: string): boolean {
  return FIRE_AND_FORGET_UI_METHODS.has(method);
}

/** Dialog methods that block for an `extension_ui_response`. */
export function isExtensionUiDialog(method: string): boolean {
  return method === "select" || method === "confirm" || method === "input" || method === "editor";
}
