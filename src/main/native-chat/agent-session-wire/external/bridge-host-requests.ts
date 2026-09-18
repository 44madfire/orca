// Session-request layer for the external bridge host (SNC1.3).
//
// Third link of the `BridgeHost` chain: the per-session provider RPC surface
// (acquire/release/dispatch/cancel/prompts/options/history/session) over the
// transport's `sendAndWait` correlation. Response/session binding checks stay
// with each call so a cross-wired provider reply never poisons host state.

import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeProtocolError,
  BridgeUnavailableError,
  createOpId,
  type BridgeHistoryEntry,
  type BridgeSessionMetadata,
  type BridgeSessionOptions,
  type DispatchAck,
  type HostToProviderMessage,
  type ProviderToHostMessage,
} from "./bridge-protocol";
import { BridgeHostSupervision } from "./bridge-host-supervision";
import { sanitizeReason, type AcquireResult, type DispatchOutcome } from "./bridge-host-types";

export class BridgeHostRequests extends BridgeHostSupervision {
  protected requireResponseSession(response: { sessionId?: string }, expected: string, op: string): void {
    if (response.sessionId !== expected) {
      throw new BridgeUnavailableError(`${op} session mismatch (refusing untrusted session)`, "BRIDGE_SESSION_MISMATCH");
    }
  }


  async acquire(init: { resumePath?: string; sessionId?: string; options?: BridgeSessionOptions } = {}): Promise<AcquireResult> {
    await this.ensureStarted();
    const opId = createOpId("acq");
    const req: HostToProviderMessage = {
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "acquire",
      opId,
      workspaceRoot: this.options.workspaceRoot,
      ...(init.resumePath ? { resumePath: init.resumePath } : {}),
      ...(init.sessionId ? { sessionId: init.sessionId } : {}),
      ...(init.options ? { options: init.options } : {}),
    };
    // Narrowed by the kind guard below, so the failure branch keeps the real kind for diagnostics.
    const res = await this.sendAndWait(req, this.requestTimeout());
    if (res.kind !== "acquired") {throw new BridgeUnavailableError(`acquire failed: ${res.kind}`, "BRIDGE_ACQUIRE_FAILED");}
    // A resume request names its session: a different id back is cross-wiring.
    // Metadata identity must always agree with the outer session id.
    if ((init.sessionId && res.sessionId !== init.sessionId) || res.metadata.sessionId !== res.sessionId) {
      throw new BridgeUnavailableError(`acquire session mismatch (refusing untrusted session)`, "BRIDGE_SESSION_MISMATCH");
    }
    this.sessions.set(res.sessionId, res.metadata);
    return { sessionId: res.sessionId, resumed: res.resumed, metadata: res.metadata };
  }


  async release(sessionId: string): Promise<void> {
    if (!this.isReady) {return;}
    const opId = createOpId("rel");
    try {
      await this.sendAndWait(
        { v: BRIDGE_PROTOCOL_VERSION, kind: "release", opId, sessionId } satisfies HostToProviderMessage,
        this.requestTimeout(),
      );
    } catch {
      // Release is best-effort during teardown; session map is cleared regardless.
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Dispatch one text message. Honest semantics:
   * - `accepted` only on explicit provider acceptance.
   * - `rejected` on explicit refusal *or* bridge-unavailable (definite).
   * - `unknown` on timeout/exit/malformed (ambiguous — never auto-resend).
   */

  async dispatch(req: {
    sessionId: string;
    text: string;
    images?: { data: string; mimeType: string }[];
    queue?: "reject" | "steer" | "followUp";
  }): Promise<DispatchOutcome> {
    if (this.disposed) {return { status: "rejected", opId: createOpId("dsp"), reason: "bridge-disposed" };}
    // Fail-closed after death: a previously healthy provider that has exited
    // is definitely unavailable. Do NOT auto-respawn here (that would turn a
    // definite rejection into an ambiguous `unknown` against a fresh provider
    // with no such session). Explicit restart() / ensureStarted() respawns.
    if (this.exited) {
      return { status: "rejected", opId: createOpId("dsp"), reason: sanitizeReason(`bridge-unavailable: provider-exited`) };
    }
    if (!this.isReady) {
      try {
        await this.ensureStarted();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { status: "rejected", opId: createOpId("dsp"), reason: sanitizeReason(`bridge-unavailable: ${reason}`) };
      }
      // ensureStarted may have raced with an exit (respawn still pending or
      // child died during hello): re-check before writing to a dead process.
      if (this.exited || !this.isReady) {
        return { status: "rejected", opId: createOpId("dsp"), reason: sanitizeReason(`bridge-unavailable: provider-exited`) };
      }
    }
    const opId = createOpId("dsp");
    const msg: HostToProviderMessage = {
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "dispatch",
      opId,
      sessionId: req.sessionId,
      message: { text: req.text, ...(req.images ? { images: req.images } : {}) },
      ...(req.queue ? { queue: req.queue } : {}),
    };
    let ack: ProviderToHostMessage;
    try {
      ack = await this.sendAndWait(msg, this.requestTimeout());
    } catch {
      // Ambiguous: the provider may still own the prompt.
      return { status: "unknown", opId, reason: "dispatch-timeout-or-exit (reconcile via history; do not auto-resend)" };
    }
    if (ack.kind !== "dispatch_ack" || ack.opId !== opId) {
      return { status: "unknown", opId, reason: `malformed-dispatch-ack: ${ack.kind} (reconcile via history)` };
    }
    const typed = ack as DispatchAck;
    // A wrong-session ack stays ambiguous: the provider may still have
    // consumed the prompt despite corrupt correlation metadata, so this is
    // `unknown` (reconcile via history), never a definite rejection.
    if (typed.sessionId !== req.sessionId) {
      return { status: "unknown", opId, reason: "session-mismatch: dispatch_ack for another session (reconcile via history; do not auto-resend)" };
    }
    if (typed.status === "accepted" || typed.status === "rejected") {
      return { status: typed.status, opId, ...(typed.reason ? { reason: sanitizeReason(typed.reason) } : {}) };
    }
    return { status: "unknown", opId, reason: sanitizeReason(typed.reason ?? "provider-unknown") };
  }


  async cancel(sessionId: string, targetOpId?: string): Promise<{ settled: boolean }> {
    await this.ensureStarted();
    const opId = createOpId("cnl");
    const res = await this.sendAndWait(
      {
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "cancel",
        opId,
        sessionId,
        ...(targetOpId ? { targetOpId } : {}),
      } satisfies HostToProviderMessage,
      this.requestTimeout(),
    );
    if (res.kind !== "cancelled") {throw new BridgeUnavailableError(`cancel failed: ${res.kind}`, "BRIDGE_CANCEL_FAILED");}
    this.requireResponseSession(res, sessionId, "cancel");
    return { settled: res.settled };
  }


  async answerPrompt(requestId: string, value: unknown, cancelled = false): Promise<void> {
    await this.ensureStarted();
    const opId = createOpId("ans");
    // answer_prompt is fire-and-forget from the host's view: the provider
    // correlates via requestId and continues the turn. Await the ack with a
    // bounded deadline but never include the value in errors.
    await this.sendAndWait(
      {
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "answer_prompt",
        opId,
        requestId,
        cancelled,
        ...(cancelled ? {} : { value }),
      } satisfies HostToProviderMessage,
      this.requestTimeout(),
    );
  }


  async setOptions(sessionId: string, options: BridgeSessionOptions): Promise<BridgeSessionOptions> {
    await this.ensureStarted();
    const opId = createOpId("opt");
    const res = await this.sendAndWait(
      { v: BRIDGE_PROTOCOL_VERSION, kind: "set_options", opId, sessionId, options } satisfies HostToProviderMessage,
      this.requestTimeout(),
    );
    if (res.kind !== "options_updated") {throw new BridgeUnavailableError(`set_options failed: ${res.kind}`, "BRIDGE_OPTIONS_FAILED");}
    this.requireResponseSession(res, sessionId, "set_options");
    return res.options;
  }


  async getHistory(sessionId: string, cursor?: string, limit?: number): Promise<{ entries: BridgeHistoryEntry[]; nextCursor?: string; leafId?: string }> {
    // API-boundary validation (programmer error): fail before any I/O so an
    // invalid limit can never read as an empty first page. Wire validation
    // enforces the same rule provider-side.
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new BridgeProtocolError("get_history limit must be a positive integer");
    }
    await this.ensureStarted();
    const opId = createOpId("his");
    const res = await this.sendAndWait(
      {
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "get_history",
        opId,
        sessionId,
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      } satisfies HostToProviderMessage,
      this.requestTimeout(),
    );
    if (res.kind !== "history") {throw new BridgeUnavailableError(`get_history failed: ${res.kind}`, "BRIDGE_HISTORY_FAILED");}
    // Refuse foreign entries rather than returning them: the response
    // identity is stripped below, so the caller could never detect it after.
    this.requireResponseSession(res, sessionId, "get_history");
    return { entries: res.entries, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}), ...(res.leafId ? { leafId: res.leafId } : {}) };
  }


  async getSession(sessionId: string): Promise<BridgeSessionMetadata> {
    await this.ensureStarted();
    const opId = createOpId("ses");
    const res = await this.sendAndWait(
      { v: BRIDGE_PROTOCOL_VERSION, kind: "get_session", opId, sessionId } satisfies HostToProviderMessage,
      this.requestTimeout(),
    );
    if (res.kind !== "session") {throw new BridgeUnavailableError(`get_session failed: ${res.kind}`, "BRIDGE_SESSION_FAILED");}
    this.requireResponseSession(res, sessionId, "get_session");
    if (res.metadata.sessionId !== sessionId) {
      throw new BridgeUnavailableError(`get_session session mismatch (refusing untrusted session)`, "BRIDGE_SESSION_MISMATCH");
    }
    this.sessions.set(sessionId, res.metadata);
    return res.metadata;
  }

  // -- teardown (joins Orca teardown) -----------------------------------------

  /**
   * Graceful (`close` + EOF→SIGTERM→SIGKILL, each bounded) or forceful
   * (SIGKILL, bounded) provider shutdown. Never hangs: every stage has a
   * hard deadline. Throws BRIDGE_EXIT_UNPROVEN when the deadline expires
   * without an observed exit — only an observed exit counts as proof, never
   * a `kill()` return or a synthetic result.
   */
}
