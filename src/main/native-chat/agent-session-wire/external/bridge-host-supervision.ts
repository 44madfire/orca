// Supervision layer for the external bridge host (SNC1.3).
//
// Middle of the `BridgeHost` chain: hello negotiation, transport-error finalization,
// proven-exit observation, and bounded shutdown. The fail-closed contract lives here:
// no synthetic exit receipts, so ownership is never released for a helper that may
// still be alive.

import type { SpawnedProcess } from "../../../../shared/child-process/run-process";
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeUnavailableError,
  createOpId,
  DEFAULT_CLOSE_GRACE_MS,
  DEFAULT_HELLO_TIMEOUT_MS,
  type HostToProviderMessage,
  type ProviderToHostMessage,
} from "./bridge-protocol";
import { BridgeHostTransport } from "./bridge-host-transport";
import { sanitizeReason, type BridgeSupport } from "./bridge-host-types";

export class BridgeHostSupervision extends BridgeHostTransport {
  async probeSupport(): Promise<BridgeSupport> {
    try {
      return await this.ensureStarted();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { available: false, reason: sanitizeReason(reason) };
    }
  }

  /** Ensure the provider is spawned + hello-negotiated. Throws fail-closed errors. */

  async ensureStarted(): Promise<BridgeSupport> {
    if (this.disposed) {throw new BridgeUnavailableError("bridge host is disposed", "BRIDGE_DISPOSED");}
    // Never spawn beside a possibly-live child: force-close (which retries
    // the kill) must settle the previous helper first.
    if (this.exitUnproven) {throw new BridgeUnavailableError("previous helper exit is unproven; force-close before starting", "BRIDGE_EXIT_UNPROVEN");}
    // A dead child never reports ready. Calling ensureStarted/probeSupport/
    // restart is the explicit restart path: drop the dead child and reset
    // exit diagnostics so the next hello starts fresh. dispatch()
    // deliberately bypasses this after exit (fail-closed, no auto-respawn).
    if (this.exited) {
      await this.abandonChildBestEffort();
      this.exited = null;
      this.helloError = null;
      this.spawnError = null;
    }
    if (this.provider && this.capabilities && !this.exited) {
      return { available: true, reason: "bridge-ready", provider: this.provider, capabilities: this.capabilities };
    }
    if (!this.starting) {this.starting = this.startAndHello();}
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /**
   * Explicit restart: settle any current child (healthy, dead, or failed),
   * then fresh hello negotiation. Refuses with BRIDGE_EXIT_UNPROVEN instead
   * of silently orphaning a helper whose exit cannot be proven. Use after
   * exit/failure instead of relying on implicit respawn (dispatch never
   * auto-respawns after death).
   */

  async restart(): Promise<BridgeSupport> {
    if (this.disposed) {throw new BridgeUnavailableError("bridge host is disposed", "BRIDGE_DISPOSED");}
    if (this.exitUnproven) {
      // Settle-or-throw: shutdownProcess proves the exit or rejects, so a
      // replacement never spawns beside a possibly-live helper.
      await this.shutdownProcess("force");
    }
    await this.abandonChildBestEffort();
    this.exited = null;
    this.helloError = null;
    this.spawnError = null;
    return this.ensureStarted();
  }


  protected async startAndHello(): Promise<BridgeSupport> {
    this.spawnProvider();
    const opId = createOpId("hello");
    const helloTimeout = this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    const hello: HostToProviderMessage = {
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "hello",
      opId,
      host: { id: "orca", version: this.options.hostVersion ?? "0.1.0", protocol: BRIDGE_PROTOCOL_VERSION },
      workspaceRoot: this.options.workspaceRoot,
    };
    let ack: ProviderToHostMessage;
    try {
      ack = await this.sendAndWait(hello, helloTimeout);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.helloError = `hello-failed: ${reason}`;
      // Failed negotiation must not leave a resident helper when the caller
      // falls back to Pi TUI and never touches the bridge again.
      await this.abandonChildBestEffort();
      throw new BridgeUnavailableError(sanitizeReason(this.helloError), "BRIDGE_HELLO_FAILED");
    }
    try {
      if (ack.kind === "hello_error") {
        this.helloError = `provider-refused: ${ack.error.code}`;
        await this.abandonChildBestEffort();
        throw new BridgeUnavailableError(sanitizeReason(`provider-refused: ${ack.error.code}`), ack.error.code);
      }
      if (ack.kind !== "hello_ok") {
        this.helloError = `unexpected-hello-reply: ${ack.kind}`;
        await this.abandonChildBestEffort();
        throw new BridgeUnavailableError(sanitizeReason(this.helloError), "BRIDGE_HELLO_UNEXPECTED");
      }
      // Defense in depth: wire validation should already have dropped a
      // malformed hello_ok (→ hello timeout above), but never dereference
      // provider/capabilities blindly — a raw TypeError must not escape with
      // the helper still resident.
      const provider = (ack as { provider?: unknown }).provider as { protocol?: unknown } | undefined;
      const capabilities = (ack as { capabilities?: unknown }).capabilities;
      if (!provider || typeof provider.protocol !== "number" || !capabilities || typeof capabilities !== "object") {
        this.helloError = `malformed-hello-ok`;
        await this.abandonChildBestEffort();
        throw new BridgeUnavailableError(sanitizeReason(this.helloError), "BRIDGE_HELLO_UNEXPECTED");
      }
      if (provider.protocol !== BRIDGE_PROTOCOL_VERSION) {
        this.helloError = `incompatible-protocol: provider=${String(provider.protocol)} host=${BRIDGE_PROTOCOL_VERSION}`;
        await this.abandonChildBestEffort();
        throw new BridgeUnavailableError(sanitizeReason(this.helloError), "BRIDGE_INCOMPATIBLE");
      }
      this.provider = ack.provider;
      this.capabilities = ack.capabilities;
      return { available: true, reason: "bridge-ready", provider: this.provider, capabilities: this.capabilities };
    } catch (error) {
      if (error instanceof BridgeUnavailableError) {throw error;}
      const reason = error instanceof Error ? error.message : String(error);
      this.helloError = `hello-failed: ${reason}`;
      await this.abandonChildBestEffort();
      throw new BridgeUnavailableError(sanitizeReason(this.helloError), "BRIDGE_HELLO_FAILED");
    }
  }

  /**
   * Best-effort bounded teardown of a failed/dead child without clearing the
   * diagnostic reason (helloError/spawnError/exited). On a proven shutdown
   * leaves the host ready for an explicit restart: proc nulled, reader
   * detached, provider cleared. On an unproven exit retains the child and
   * marks it (see exitUnproven) instead of silently orphaning a
   * possibly-live helper. Never throws and never hangs.
   */

  protected async abandonChildBestEffort(): Promise<void> {
    const proc = this.proc;
    if (proc) {
      try {
        await this.shutdownProcessInner(proc, "force");
      } catch (error) {
        if (error instanceof BridgeUnavailableError && error.code === "BRIDGE_EXIT_UNPROVEN") {
          // Retain: ensureStarted/restart refuse to spawn beside it, and a
          // later force-close retries the kill against the same handle.
          this.exitUnproven = true;
          return;
        }
        // Best-effort: never let other cleanup errors throw.
      }
    }
    this.exitUnproven = false;
    this.detachAll();
    this.proc = null;
    this.provider = null;
    this.capabilities = null;
    this.sessions.clear();
    // Do not clear helloError/spawnError/exited here: support.reason needs them.
    // ensureStarted/restart reset them before a fresh spawn (see below).
  }


  protected terminateOnTransportError(source: "stdin" | "stdout" | "stderr" | "child", error: unknown): void {
    const proc = this.proc;
    if (!proc && (this.exited || this.exitUnproven)) {return;}
    const osMessage = sanitizeReason(error instanceof Error ? error.message : String(error));
    this.spawnError = source === "child" ? `process-error: ${osMessage}` : `transport-${source}-error: ${osMessage}`;
    // Proven death (a raced real exit) always wins; otherwise the exit is
    // unproven and teardown must stay unsettled until exit evidence lands.
    if (!this.exited) {this.exitUnproven = true;}
    this.provider = null;
    this.capabilities = null;
    this.sessions.clear();
    this.detachAll();
    // Keep the failing proc reachable just long enough to kill/destroy it.
    try {
      proc?.kill("SIGKILL");
    } catch {
      // Already dead.
    }
    try {
      (proc?.stdout as unknown as { destroy?: () => void })?.destroy?.();
    } catch {
      // Ignore.
    }
    try {
      (proc?.stderr as unknown as { destroy?: () => void })?.destroy?.();
    } catch {
      // Ignore.
    }
    // Retain `proc`: the exit is unproven (see above), so teardown must be
    // able to wait on / retry the kill against the same handle. A later
    // real exit settles teardown; explicit restart replaces the child.
    if (proc) {this.armExitWatch(proc);}
    this.failAllPending(new BridgeUnavailableError(sanitizeReason(this.spawnError), "BRIDGE_PROCESS_ERROR"));
    this.emitLifecycle({ kind: "provider-error", message: sanitizeReason(this.spawnError) });
  }

  /** Normal child exit path (no prior terminal error). Later errors on the detached proc are no-ops. */

  protected handleChildExit(code: number | null, signal: string | null): void {
    if (!this.proc && this.exited) {return;}
    this.exited = { code, signal };
    // An observed exit is proof of death, including after a transport error
    // that left the exit unproven: teardown may settle from here.
    this.exitUnproven = false;
    // Finalize so support/ensureStarted never report stale ready and the
    // next explicit start spawns fresh. In-flight dispatches resolve
    // `unknown` (ambiguous ownership); post-exit dispatches reject as
    // bridge-unavailable without auto-respawn (see dispatch()).
    this.provider = null;
    this.capabilities = null;
    this.sessions.clear();
    const proc = this.proc;
    this.detachAll();
    try {
      (proc?.stdout as unknown as { destroy?: () => void })?.destroy?.();
    } catch {
      // Ignore.
    }
    try {
      (proc?.stderr as unknown as { destroy?: () => void })?.destroy?.();
    } catch {
      // Ignore.
    }
    this.proc = null;
    this.failAllPending(new BridgeUnavailableError(`provider-exited code=${code} signal=${signal}`, "BRIDGE_EXITED"));
    this.emitLifecycle({ kind: "provider-exit", message: `provider exited code=${code} signal=${signal}`, code, signal });
  }

  // -- session operations ----------------------------------------------------


  protected armExitWatch(proc: SpawnedProcess): void {
    try {
      this.detachExitWatch?.();
    } catch {
      // Cleanup must not throw.
    }
    this.detachExitWatch = null;
    const onExit = (code: number | null, signal: string | null): void => {
      this.detachExitWatch = null;
      this.handleChildExit(code, signal);
    };
    const off = (): void => {
      try {
        ;(
          proc as unknown as {
            off?(event: string, listener: (...args: unknown[]) => void): unknown
          }
        )?.off?.("exit", onExit as (...args: unknown[]) => void);
      } catch {
        // Cleanup must not throw.
      }
    };
    try {
      // `once`: one-shot observation matches the self-removing contract
      // and stays compatible with minimal proc fakes (same surface the
      // shutdown waits use).
      ;(
        proc as unknown as {
          once(event: string, listener: (...args: unknown[]) => void): unknown
        }
      ).once("exit", onExit as (...args: unknown[]) => void);
    } catch {
      return;
    }
    this.detachExitWatch = off;
  }

  /** Wait for one explicit proc's exit with a hard deadline; always resolves. */

  protected waitForProcExit(proc: SpawnedProcess, timeoutMs: number): Promise<{ code: number | null; signal: string | null } | "timeout"> {
    // Fast path: already observed via the host exit handler or exitCode.
    if (this.exited) {return Promise.resolve({ ...this.exited });}
    if ((proc.exitCode as number | null | undefined) != null || (proc as unknown as { signalCode?: string | null }).signalCode != null) {
      return Promise.resolve({ code: proc.exitCode, signal: (proc as unknown as { signalCode?: string | null }).signalCode ?? null });
    }
    return new Promise((resolve) => {
      const onExit = (code: number | null, signal: string | null): void => {
        clearTimeout(timer);
        resolve({ code, signal });
      };
      const timer = setTimeout(() => {
        proc.off("exit", onExit);
        resolve("timeout");
      }, timeoutMs);
      proc.once("exit", onExit);
    });
  }

  /**
   * Bounded shutdown of one explicit child: EOF grace → SIGTERM grace →
   * SIGKILL grace. Never hangs. Throws BRIDGE_EXIT_UNPROVEN when the final
   * grace expires without an observed exit: a `kill()` return is never
   * trusted as proof (it reports delivery, not death), so only the exit
   * event or a prior exit code/signal counts.
   */

  protected async shutdownProcessInner(proc: SpawnedProcess, mode: "graceful" | "force"): Promise<{ code: number | null; signal: string | null }> {
    const eofGrace = this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    const killGrace = this.killGraceMs();
    if (mode === "graceful") {
      try {
        (proc.stdin as unknown as { end(): void }).end();
      } catch {
        // Already closed.
      }
      const eof = await this.waitForProcExit(proc, eofGrace);
      if (eof !== "timeout") {return eof;}
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      const termed = await this.waitForProcExit(proc, killGrace);
      if (termed !== "timeout") {return termed;}
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    const killed = await this.waitForProcExit(proc, killGrace);
    if (killed !== "timeout") {return killed;}
    // No synthetic success: the helper ignored even SIGKILL (only possible
    // for swallowed-signal fakes; real SIGKILL cannot be ignored), so its
    // death is unproven. The caller must not treat teardown as settled.
    throw new BridgeUnavailableError(
      "provider exit unproven after SIGKILL grace; helper may still be running",
      "BRIDGE_EXIT_UNPROVEN",
    );
  }

  /**
   * Shut down the current child, if any. Throws BRIDGE_EXIT_UNPROVEN when
   * the exit cannot be proven; a missing child with no observed exit is the
   * only case that resolves without proof (there is nothing to kill).
   */


  protected async shutdownProcess(mode: "graceful" | "force"): Promise<{ code: number | null; signal: string | null }> {
    const proc = this.proc;
    if (!proc) {
      // No child handle exists, so nothing can be duplicated: vacuous settle.
      this.exitUnproven = false;
      return { code: null, signal: null };
    }
    // Already observed exit (e.g. dispose runs close + force shutdown back to
    // back): return it instead of waiting for a second exit that never comes.
    if (this.exited) {return { ...this.exited };}
    // Loose `!= null` covers both `null` (real spawned child, running) and
    // `undefined` (in-memory fakes with no exitCode field).
    if ((proc.exitCode as number | null | undefined) != null || (proc as unknown as { signalCode?: string | null }).signalCode != null) {
      return { code: proc.exitCode, signal: (proc as unknown as { signalCode?: string | null }).signalCode ?? null };
    }
    const result = await this.shutdownProcessInner(proc, mode);
    // Normal return proves the exit (observed event, exit code, or signal).
    this.exitUnproven = false;
    return result;
  }
}
