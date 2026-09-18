// Wire validation for the SNC1.3 external structured-session bridge.
//
// Split from `bridge-protocol` (line budget): credential guards and per-kind record
// validators over the shapes in `bridge-protocol-types`.

import { FORBIDDEN_BRIDGE_KEYS } from './bridge-protocol-types';
import { BridgeProtocolError } from './bridge-protocol-errors';

function hasForbiddenKey(value: unknown, seen: string[] = []): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = hasForbiddenKey(item, seen);
      if (hit) {return hit;}
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase().replace(/[_-]/g, "");
      for (const forbidden of FORBIDDEN_BRIDGE_KEYS) {
        const f = forbidden.toLowerCase().replace(/[_-]/g, "");
        if (lower === f || lower.endsWith(f)) {return [...seen, k].join(".");}
      }
      const hit = hasForbiddenKey(v, [...seen, k]);
      if (hit) {return hit;}
    }
  }
  return null;
}

/**
 * Fail-closed credential guard. Returns the offending key path, or null.
 * Both host and provider call this before sending *and* after receiving.
 */
export function findCredentialField(value: unknown): string | null {
  return hasForbiddenKey(value);
}

/** Throw a `BridgeProtocolError` when credential fields are present. */
export function assertNoCredentialFields(value: unknown, where: string): void {
  const hit = findCredentialField(value);
  if (hit) {throw new BridgeProtocolError(`refusing to send ${where}: forbidden credential field "${hit}"`);}
}

export function isStr(x: unknown): x is string {
  return typeof x === "string";
}

export function isRec(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

const CAPABILITY_KEYS = [
  "textStreaming",
  "thinking",
  "tools",
  "images",
  "extensionDialogs",
  "history",
  "options",
  "cancel",
  "resume",
] as const;

/** Every capability flag is required: Orca UI gates controls on each boolean. */
export function validateCapabilities(caps: unknown): string | null {
  if (!isRec(caps)) {return "hello_ok-missing-capabilities";}
  for (const key of CAPABILITY_KEYS) {
    if (typeof caps[key] !== "boolean") {return "hello_ok-bad-capabilities";}
  }
  return null;
}

/** Inner fields the host lease/session APIs rely on. */
export function validateSessionMetadata(meta: unknown, missingCode: string, badCode: string): string | null {
  if (!isRec(meta)) {return missingCode;}
  if (!isStr(meta["sessionId"])) {return badCode;}
  if (!isStr(meta["workspaceRoot"])) {return badCode;}
  if (typeof meta["messageCount"] !== "number") {return badCode;}
  if (typeof meta["isStreaming"] !== "boolean") {return badCode;}
  if (!isStr(meta["createdAt"])) {return badCode;}
  if (meta["providerSessionId"] !== undefined && !isStr(meta["providerSessionId"])) {return badCode;}
  if (meta["model"] !== undefined && !isStr(meta["model"])) {return badCode;}
  if (meta["thinkingLevel"] !== undefined && !isStr(meta["thinkingLevel"])) {return badCode;}
  return null;
}

export const QUEUE_MODES: ReadonlySet<string> = new Set(["reject", "steer", "followUp"]);

/** Option-bag inner fields session/lease code relies on. Extra keys stay forward-compatible. */
export function validateSessionOptions(opts: unknown, missingCode: string, badCode: string): string | null {
  if (!isRec(opts)) {return missingCode;}
  if (opts["model"] !== undefined && !isStr(opts["model"])) {return badCode;}
  if (opts["thinkingLevel"] !== undefined && !isStr(opts["thinkingLevel"])) {return badCode;}
  if (
    opts["queueMode"] !== undefined &&
    (typeof opts["queueMode"] !== "string" || !QUEUE_MODES.has(opts["queueMode"]))
  ) {return badCode;}
  if (opts["autoCompaction"] !== undefined && typeof opts["autoCompaction"] !== "boolean") {return badCode;}
  return null;
}

const ENTRY_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "tool", "system"]);

/** History entries the journal/UI renders must carry identity + role. */
export function validateHistoryEntries(entries: unknown): string | null {
  if (!Array.isArray(entries)) {return "history-missing-entries";}
  for (const entry of entries) {
    if (!isRec(entry) || !isStr(entry["id"]) || !ENTRY_ROLES.has(entry["role"] as string)) {
      return "history-bad-entry";
    }
  }
  return null;
}

/** Per-event payload the renderer/correlation relies on. */
export function validateProviderEvent(event: unknown): string | null {
  if (!isRec(event) || !isStr(event["type"])) {return "event-missing-event";}
  const field = (key: string): unknown => event[key];
  switch (event["type"] as string) {
    case "text_delta":
      return isStr(field("delta")) ? null : "event-bad-text_delta";
    case "thinking_delta":
      return isStr(field("delta")) ? null : "event-bad-thinking_delta";
    case "tool_start":
      return isStr(field("toolCallId")) && isStr(field("toolName")) ? null : "event-bad-tool_start";
    case "tool_progress":
      return isStr(field("toolCallId")) && isStr(field("partialResult")) ? null : "event-bad-tool_progress";
    case "tool_end":
      return isStr(field("toolCallId")) && isStr(field("result")) && typeof field("isError") === "boolean"
        ? null
        : "event-bad-tool_end";
    case "turn_end": {
      const stop = field("stopReason");
      return stop === "stop" || stop === "aborted" || stop === "error" ? null : "event-bad-turn_end";
    }
    case "prompt_request": {
      if (!isStr(field("requestId"))) {return "event-bad-prompt_request";}
      const prompt = field("prompt");
      if (!isRec(prompt) || !isStr(prompt["kind"])) {return "event-bad-prompt_request";}
      switch (prompt["kind"] as string) {
        case "select": {
          const options: unknown = prompt["options"];
          if (!isStr(prompt["title"])) {return "event-bad-prompt_request";}
          if (!Array.isArray(options) || options.length === 0 || !options.every((o) => typeof o === "string")) {
            return "event-bad-prompt_request";
          }
          break;
        }
        case "confirm":
          if (!isStr(prompt["title"]) || !isStr(prompt["message"])) {return "event-bad-prompt_request";}
          break;
        case "input":
          if (!isStr(prompt["title"])) {return "event-bad-prompt_request";}
          if (prompt["placeholder"] !== undefined && !isStr(prompt["placeholder"])) {return "event-bad-prompt_request";}
          break;
        case "editor":
          if (!isStr(prompt["title"])) {return "event-bad-prompt_request";}
          if (prompt["prefill"] !== undefined && !isStr(prompt["prefill"])) {return "event-bad-prompt_request";}
          break;
        default:
          return "event-bad-prompt_request";
      }
      if (field("timeoutMs") !== undefined && typeof field("timeoutMs") !== "number") {return "event-bad-prompt_request";}
      return null;
    }
    case "error":
      return isStr(field("code")) && isStr(field("message")) ? null : "event-bad-error";
    case "turn_start":
    case "text_start":
    case "text_end":
    case "thinking_start":
    case "thinking_end":
    case "settled":
      // Type-only variants: no payload downstream relies on.
      return null;
    default:
      // Unknown event types must not reach session listeners as trusted state.
      return "event-unknown-type";
  }
}

export function validateExitBlock(exit: unknown): boolean {
  return (
    isRec(exit) &&
    (typeof exit["code"] === "number" || exit["code"] === null) &&
    (typeof exit["signal"] === "string" || exit["signal"] === null)
  );
}

export function validateLimit(limit: unknown): string | null {
  if (limit === undefined) {return null;}
  return Number.isInteger(limit) && (limit as number) >= 1 ? null : "get_history-bad-limit";
}

/**
 * Validate the shape of one parsed bridge record.
 * Returns null when valid, otherwise a short machine-readable reason
 * (never includes prompt text or environment values).
 */