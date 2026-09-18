// Wire envelopes for the SNC1.3 external structured-session bridge.
//
// Split from `bridge-protocol` (line budget): every record shape that crosses the
// stdio transport, over the payload types in `bridge-protocol-types`.

import type {
  BridgeCapabilities,
  BridgeDispatchMessage,
  BridgeHistoryEntry,
  BridgeHostIdentity,
  BridgeProviderEvent,
  BridgeProviderIdentity,
  BridgeSessionMetadata,
  BridgeSessionOptions,
} from './bridge-protocol-types';

// ---------------------------------------------------------------------------
// Wire records (every record carries `v`).
// ---------------------------------------------------------------------------

export type BridgeWireBase = {
  v: number;
  kind: string;
  opId?: string;
}

export type HelloRequest = {
  kind: "hello";
  opId: string;
  host: BridgeHostIdentity;
  workspaceRoot: string;
} & BridgeWireBase

export type AcquireRequest = {
  kind: "acquire";
  opId: string;
  workspaceRoot: string;
  resumePath?: string;
  sessionId?: string;
  options?: BridgeSessionOptions;
} & BridgeWireBase

export type ReleaseRequest = {
  kind: "release";
  opId: string;
  sessionId: string;
} & BridgeWireBase

export type DispatchRequest = {
  kind: "dispatch";
  opId: string;
  sessionId: string;
  message: BridgeDispatchMessage;
  queue?: "reject" | "steer" | "followUp";
} & BridgeWireBase

export type CancelRequest = {
  kind: "cancel";
  opId: string;
  sessionId: string;
  targetOpId?: string;
} & BridgeWireBase

export type AnswerPromptRequest = {
  kind: "answer_prompt";
  opId: string;
  requestId: string;
  cancelled: boolean;
  value?: unknown;
} & BridgeWireBase

export type SetOptionsRequest = {
  kind: "set_options";
  opId: string;
  sessionId: string;
  options: BridgeSessionOptions;
} & BridgeWireBase

export type GetHistoryRequest = {
  kind: "get_history";
  opId: string;
  sessionId: string;
  cursor?: string;
  limit?: number;
} & BridgeWireBase

export type GetSessionRequest = {
  kind: "get_session";
  opId: string;
  sessionId: string;
} & BridgeWireBase

export type CloseRequest = {
  kind: "close";
  opId: string;
  mode: "graceful" | "force";
  sessionId?: string;
} & BridgeWireBase

export type HostToProviderMessage =
  | HelloRequest
  | AcquireRequest
  | ReleaseRequest
  | DispatchRequest
  | CancelRequest
  | AnswerPromptRequest
  | SetOptionsRequest
  | GetHistoryRequest
  | GetSessionRequest
  | CloseRequest;

export type HelloOk = {
  kind: "hello_ok";
  opId: string;
  provider: BridgeProviderIdentity;
  capabilities: BridgeCapabilities;
} & BridgeWireBase

export type HelloError = {
  kind: "hello_error";
  opId: string;
  error: { code: string; message: string };
} & BridgeWireBase

export type AcquiredResponse = {
  kind: "acquired";
  opId: string;
  sessionId: string;
  resumed: boolean;
  metadata: BridgeSessionMetadata;
} & BridgeWireBase

export type ReleasedResponse = {
  kind: "released";
  opId: string;
  sessionId: string;
} & BridgeWireBase

export type DispatchStatus = "accepted" | "rejected" | "unknown";

export type DispatchAck = {
  kind: "dispatch_ack";
  opId: string;
  sessionId: string;
  status: DispatchStatus;
  reason?: string;
} & BridgeWireBase

export type CancelledResponse = {
  kind: "cancelled";
  opId: string;
  sessionId: string;
  targetOpId: string;
  settled: boolean;
} & BridgeWireBase

export type OptionsUpdatedResponse = {
  kind: "options_updated";
  opId: string;
  sessionId: string;
  options: BridgeSessionOptions;
} & BridgeWireBase

export type HistoryResponse = {
  kind: "history";
  opId: string;
  sessionId: string;
  entries: BridgeHistoryEntry[];
  nextCursor?: string;
  leafId?: string;
} & BridgeWireBase

export type SessionResponse = {
  kind: "session";
  opId: string;
  sessionId: string;
  metadata: BridgeSessionMetadata;
} & BridgeWireBase

export type SessionEvent = {
  kind: "session_event";
  sessionId: string;
  opId?: string;
  event: BridgeProviderEvent;
} & BridgeWireBase

export type ClosedResponse = {
  kind: "closed";
  opId: string;
  sessionId?: string;
  exit: { code: number | null; signal: string | null };
} & BridgeWireBase

export type ExitingEvent = {
  kind: "exiting";
  exit: { code: number | null; signal: string | null };
  reason: string;
} & BridgeWireBase

export type BridgeErrorEvent = {
  kind: "error";
  opId?: string;
  sessionId?: string;
  error: { code: string; message: string };
} & BridgeWireBase

export type ProviderToHostMessage =
  | HelloOk
  | HelloError
  | AcquiredResponse
  | ReleasedResponse
  | DispatchAck
  | CancelledResponse
  | OptionsUpdatedResponse
  | HistoryResponse
  | SessionResponse
  | SessionEvent
  | ClosedResponse
  | ExitingEvent
  | BridgeErrorEvent;
