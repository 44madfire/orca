// Bridge record dispatcher validation.
//
// Split from `bridge-protocol` (line budget): the top-level `validateBridgeMessage`
// dispatcher over the field validators in `bridge-protocol-validation`.

import {
  BRIDGE_PROTOCOL_VERSION,
  H2P_KINDS,
  P2H_KINDS,
} from './bridge-protocol-types';
import {
  findCredentialField,
  isRec,
  isStr,
  QUEUE_MODES,
  validateCapabilities,
  validateExitBlock,
  validateHistoryEntries,
  validateLimit,
  validateProviderEvent,
  validateSessionMetadata,
  validateSessionOptions,
} from './bridge-protocol-validation';

export function validateBridgeMessage(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {return "not-an-object";}
  const v = value as Record<string, unknown>;
  if (v["v"] !== BRIDGE_PROTOCOL_VERSION) {return "bad-version";}
  if (typeof v["kind"] !== "string") {return "missing-kind";}
  const kind = v["kind"] as string;
  const known = H2P_KINDS.has(kind) || P2H_KINDS.has(kind);
  if (!known) {return "unknown-kind";}
  const needsOp = new Set([
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
    "hello_ok",
    "hello_error",
    "acquired",
    "released",
    "dispatch_ack",
    "cancelled",
    "options_updated",
    "history",
    "session",
    "closed",
  ]);
  if (needsOp.has(kind) && typeof v["opId"] !== "string") {return "missing-opId";}
  if (findCredentialField(value) !== null) {return "credential-field";}
  const sessionId = (code: string): string | null => (isStr(v["sessionId"]) ? null : code);
  const optStr = (key: string, code: string): string | null =>
    v[key] === undefined || isStr(v[key]) ? null : code;
  switch (kind) {
    case "hello": {
      if (!isRec(v["host"]) || !isStr(v["host"].id) || !isStr(v["host"].version)) {return "hello-bad-protocol";}
      if (v["host"].protocol !== BRIDGE_PROTOCOL_VERSION) {return "hello-bad-protocol";}
      if (!isStr(v["workspaceRoot"])) {return "hello-missing-workspaceRoot";}
      break;
    }
    case "acquire": {
      if (!isStr(v["workspaceRoot"])) {return "acquire-missing-workspaceRoot";}
      const badSession = optStr("sessionId", "acquire-bad-sessionId");
      if (badSession) {return badSession;}
      const badResume = optStr("resumePath", "acquire-bad-resumePath");
      if (badResume) {return badResume;}
      if (v["options"] !== undefined) {
        const badOptions = validateSessionOptions(v["options"], "acquire-bad-options", "acquire-bad-options");
        if (badOptions) {return badOptions;}
      }
      break;
    }
    case "release":
    case "get_session": {
      const bad = sessionId(`${kind}-missing-sessionId`);
      if (bad) {return bad;}
      break;
    }
    case "get_history": {
      const bad = sessionId("get_history-missing-sessionId");
      if (bad) {return bad;}
      const badCursor = optStr("cursor", "get_history-bad-cursor");
      if (badCursor) {return badCursor;}
      const badLimit = validateLimit(v["limit"]);
      if (badLimit) {return badLimit;}
      break;
    }
    case "dispatch": {
      const bad = sessionId("dispatch-missing-sessionId");
      if (bad) {return bad;}
      const msg = v["message"];
      if (!isRec(msg) || typeof msg["text"] !== "string") {return "dispatch-missing-text";}
      if (
        v["queue"] !== undefined &&
        (typeof v["queue"] !== "string" || !QUEUE_MODES.has(v["queue"]))
      ) {return "dispatch-bad-queue";}
      if (msg["images"] !== undefined) {
        if (!Array.isArray(msg["images"])) {return "dispatch-bad-images";}
        for (const image of msg["images"]) {
          if (!isRec(image) || !isStr(image["data"]) || !isStr(image["mimeType"])) {return "dispatch-bad-images";}
        }
      }
      break;
    }
    case "cancel": {
      const bad = sessionId("cancel-missing-sessionId");
      if (bad) {return bad;}
      const badTarget = optStr("targetOpId", "cancel-bad-targetOpId");
      if (badTarget) {return badTarget;}
      break;
    }
    case "answer_prompt": {
      if (!isStr(v["requestId"])) {return "answer_prompt-missing-requestId";}
      if (typeof v["cancelled"] !== "boolean") {return "answer_prompt-missing-cancelled";}
      break;
    }
    case "set_options": {
      const bad = sessionId("set_options-missing-sessionId");
      if (bad) {return bad;}
      const badOptions = validateSessionOptions(v["options"], "set_options-missing-options", "set_options-bad-options");
      if (badOptions) {return badOptions;}
      break;
    }
    case "close": {
      if (v["mode"] !== "graceful" && v["mode"] !== "force") {return "close-missing-mode";}
      const bad = optStr("sessionId", "close-bad-sessionId");
      if (bad) {return bad;}
      break;
    }
    case "hello_ok": {
      const provider = v["provider"];
      if (!isRec(provider) || !isStr(provider["id"]) || !isStr(provider["version"]) || typeof provider["protocol"] !== "number") {
        return "hello_ok-missing-provider";
      }
      const badCaps = validateCapabilities(v["capabilities"]);
      if (badCaps) {return badCaps;}
      break;
    }
    case "hello_error":
    case "error": {
      const error = v["error"];
      if (!isRec(error) || !isStr(error["code"]) || !isStr(error["message"])) {return `${kind}-missing-error`;}
      break;
    }
    case "acquired": {
      if (!isStr(v["sessionId"])) {return "acquired-missing-sessionId";}
      if (typeof v["resumed"] !== "boolean") {return "acquired-missing-resumed";}
      const badMeta = validateSessionMetadata(v["metadata"], "acquired-missing-metadata", "acquired-bad-metadata");
      if (badMeta) {return badMeta;}
      break;
    }
    case "released": {
      const bad = sessionId("released-missing-sessionId");
      if (bad) {return bad;}
      break;
    }
    case "dispatch_ack": {
      const bad = sessionId("dispatch_ack-missing-sessionId");
      if (bad) {return bad;}
      if (v["status"] !== "accepted" && v["status"] !== "rejected" && v["status"] !== "unknown") {
        return "dispatch_ack-missing-status";
      }
      break;
    }
    case "cancelled": {
      const bad = sessionId("cancelled-missing-sessionId");
      if (bad) {return bad;}
      if (!isStr(v["targetOpId"])) {return "cancelled-missing-targetOpId";}
      if (typeof v["settled"] !== "boolean") {return "cancelled-missing-settled";}
      break;
    }
    case "options_updated": {
      const bad = sessionId("options_updated-missing-sessionId");
      if (bad) {return bad;}
      const badOptions = validateSessionOptions(v["options"], "options_updated-missing-options", "options_updated-bad-options");
      if (badOptions) {return badOptions;}
      break;
    }
    case "history": {
      const bad = sessionId("history-missing-sessionId");
      if (bad) {return bad;}
      const badEntries = validateHistoryEntries(v["entries"]);
      if (badEntries) {return badEntries;}
      break;
    }
    case "session": {
      const bad = sessionId("session-missing-sessionId");
      if (bad) {return bad;}
      const badMeta = validateSessionMetadata(v["metadata"], "session-missing-metadata", "session-bad-metadata");
      if (badMeta) {return badMeta;}
      break;
    }
    case "session_event": {
      if (typeof v["sessionId"] !== "string") {return "event-missing-sessionId";}
      const badEvent = validateProviderEvent(v["event"]);
      if (badEvent) {return badEvent;}
      break;
    }
    case "closed": {
      if (!validateExitBlock(v["exit"])) {return "closed-missing-exit";}
      break;
    }
    case "exiting": {
      if (!validateExitBlock(v["exit"])) {return "exiting-missing-exit";}
      if (!isStr(v["reason"])) {return "exiting-missing-reason";}
      break;
    }
    default:
      break;
  }
  return null;
}

/** True when the value is a well-formed bridge record with no credential fields. */
export function isBridgeMessage(value: unknown): boolean {
  return validateBridgeMessage(value) === null;
}
