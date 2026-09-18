/**
 * Orca-side bridge host (SNC1.3).
 *
 * This is the generic external-adapter seam that a temporary Orca dev
 * branch vendors alongside `framing.ts` + `protocol.ts`. Orca keeps
 * ownership of journal, lease/fencing, outbox/idempotency, rendering, and
 * client synchronization; this host only transports opaque provider events
 * into Orca callbacks.
 *
 * Fail-closed contract:
 * - Missing binary, spawn failure, hello timeout, version mismatch, or
 *   `hello_error` → `available === false` with a short `reason`. The caller
 *   keeps the normal Pi TUI path untouched (see `probeSupport()`).
 * - `dispatch()` returns `accepted` only on an explicit provider
 *   `dispatch_ack{accepted}`, `rejected` only on explicit refusal
 *   (including bridge-unavailable), and `unknown` on timeout / exit /
 *   malformed ack. Unknown prompts are never auto-resent.
 *
 * Teardown: `dispose()` joins Orca teardown — bounded EOF grace → SIGTERM
 * grace → SIGKILL grace (never hangs), plus listener detach and timer
 * clear. Idempotent. An unproven exit throws BRIDGE_EXIT_UNPROVEN instead
 * of a success receipt so the host never releases ownership of a helper
 * that may still be alive.
 *
 * Secret hygiene: the host never sends `env`/credentials over the bridge
 * and never includes prompt text in errors. Stderr is bounded + redacted.
 *
 * Layered to fit the line budget (`transport -> supervision -> requests ->
 * host`, the same inheritance pattern as the Pi RPC connection); behavior
 * is unchanged. Session requests live in `bridge-host-requests`, process
 * supervision in `bridge-host-supervision`, and the transport in
 * `bridge-host-transport`.
 */

import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeUnavailableError,
  createOpId,
  redactSecretsFromText,
  type BridgeProviderIdentity,
  type HostToProviderMessage,
} from "./bridge-protocol";
import { BridgeHostRequests } from "./bridge-host-requests";
import {
  sanitizeReason,
  type BridgeSupport,
  type LifecycleEnvelope,
  type SessionEventEnvelope,
} from "./bridge-host-types";

export type {
  AcquireResult,
  BridgeHostOptions,
  BridgeSupport,
  DispatchOutcome,
  LifecycleEnvelope,
  SessionEventEnvelope,
  SpawnFn,
} from "./bridge-host-types";
export class BridgeHost extends BridgeHostRequests {
  get support(): BridgeSupport {
    // Exited always wins: a dead provider is never reported ready, even if
    // identity/capabilities are still cached for diagnostics. Prefer the
    // process-error detail when an `error` raced hello (both set).
    if (this.exited) {
      const reason = this.spawnError ?? this.helloError ?? `provider-exited`;
      return { available: false, reason: sanitizeReason(reason) };
    }
    if (this.provider && this.capabilities) {
      return { available: true, reason: "bridge-ready", provider: this.provider, capabilities: this.capabilities };
    }
    const reason = this.helloError ?? this.spawnError ?? "bridge-not-started";
    return { available: false, reason: sanitizeReason(reason) };
  }

  get providerInfo(): BridgeProviderIdentity | null {
    return this.provider;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Bounded, redacted stderr snippet for diagnostics (never raw env). */
  get stderrSnippet(): string {
    return redactSecretsFromText(this.stderr, this.maxStderr);
  }

  /** OS pid of the provider child, for Orca lease process identity. Null when not spawned. */
  get providerPid(): number | null {
    return this.proc?.pid ?? null;
  }

  onSessionEvent(listener: (envelope: SessionEventEnvelope) => void): () => void {
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  onLifecycle(listener: (envelope: LifecycleEnvelope) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * Probe structured support without throwing. Spawns the provider on first
   * call, runs hello negotiation, and reports fail-closed availability.
   * Safe to call repeatedly; leaves a ready host running on success.
   */

  async close(mode: "graceful" | "force" = "graceful"): Promise<{ code: number | null; signal: string | null }> {
    const proc = this.proc;
    if (!proc) {return this.exited ? { ...this.exited } : { code: null, signal: null };}
    // Handshake when the child is healthy, even mid-dispose (`isReady` is
    // false once `disposed` is set, but dispose still promises the bridge
    // `close` handshake before falling back to EOF/kill).
    if (mode === "graceful" && this.provider && !this.exited) {
      try {
        const opId = createOpId("cls");
        await this.sendAndWait(
          { v: BRIDGE_PROTOCOL_VERSION, kind: "close", opId, mode: "graceful" } satisfies HostToProviderMessage,
          Math.min(this.requestTimeout(), 3_000),
        );
      } catch {
        // Fall through to EOF/SIGTERM below.
      }
    }
    return this.shutdownProcess(mode);
  }

  /**
   * Join Orca teardown: close (graceful then force), detach the stdio
   * reader, clear timers/listeners, and kill the helper. Idempotent once
   * settled; a retry after BRIDGE_EXIT_UNPROVEN re-attempts the force kill.
   * Throws BRIDGE_EXIT_UNPROVEN (retaining the child handle) when the final
   * grace expires without an observed exit, so the caller must not release
   * ownership of a helper that may still be alive.
   */

  async dispose(): Promise<void> {
    if (this.disposed && !this.exitUnproven) {return;}
    this.disposed = true;
    try {
      await this.close("graceful");
    } catch {
      // Swallowed: transport failures and an unproven graceful close both
      // fall through to the force kill below, which is authoritative.
    }
    try {
      await this.shutdownProcess("force");
    } catch (error) {
      if (error instanceof BridgeUnavailableError && error.code === "BRIDGE_EXIT_UNPROVEN") {
        this.exitUnproven = true;
        this.detachAll();
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new BridgeUnavailableError("bridge host disposed", "BRIDGE_DISPOSED"));
        }
        this.pending.clear();
        this.sessionListeners.clear();
        this.lifecycleListeners.clear();
        this.sessions.clear();
        // Retain `proc`: a later force-close retries the kill against the
        // same handle instead of orphaning a possibly-live helper. Re-arm
        // exit observation (detachAll above removed it) so a real exit
        // still settles teardown.
        if (this.proc) {this.armExitWatch(this.proc);}
        throw error;
      }
      // Ignore — process already gone.
    }
    this.detachAll();
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeUnavailableError("bridge host disposed", "BRIDGE_DISPOSED"));
    }
    this.pending.clear();
    this.sessionListeners.clear();
    this.lifecycleListeners.clear();
    this.sessions.clear();
    this.proc = null;
  }

  // -- internals ---------------------------------------------------------------

}
