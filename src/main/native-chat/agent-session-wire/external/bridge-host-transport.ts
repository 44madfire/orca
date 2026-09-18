// Process transport for the external bridge host (SNC1.3).
//
// Base layer of the `BridgeHost` chain (`transport -> supervision -> requests -> host`):
// child-process ownership, stdio framing IO, pending-request correlation, and event
// emission. Exit proof and bounded shutdown live one layer up in `bridge-host-supervision`.

import { spawnProcess, type SpawnedProcess } from "../../../../shared/child-process/run-process";
import {
  assertNoCredentialFields,
  BridgeUnavailableError,
  DEFAULT_CLOSE_GRACE_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_STDERR_BYTES,
  validateBridgeMessage,
  type BridgeCapabilities,
  type BridgeProviderIdentity,
  type BridgeSessionMetadata,
  type ClosedResponse,
  type DispatchAck,
  type HostToProviderMessage,
  type ProviderToHostMessage,
} from "./bridge-protocol";
import { attachBridgeReader, serializeBridgeLine, type BridgeReadable } from "./bridge-framing";
import {
  sanitizeReason,
  type BridgeHostOptions,
  type BridgeSupport,
  type LifecycleEnvelope,
  type SessionEventEnvelope,
  type SpawnFn,
} from "./bridge-host-types";

type PendingEntry = {
  kind: string;
  resolve: (value: ProviderToHostMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export abstract class BridgeHostTransport {
  /** Finalized by the supervision layer; the transport only observes through it. */
  protected abstract terminateOnTransportError(
    source: 'stdin' | 'stdout' | 'stderr' | 'child',
    error: unknown
  ): void;
  /** Finalized by the supervision layer; the transport only observes through it. */
  protected abstract handleChildExit(code: number | null, signal: string | null): void;
  protected proc: SpawnedProcess | null = null;
  protected detachReader: (() => void) | null = null;
  protected detachFns: (() => void)[] = [];
  protected readonly pending = new Map<string, PendingEntry>();
  protected readonly sessionListeners = new Set<(envelope: SessionEventEnvelope) => void>();
  protected readonly lifecycleListeners = new Set<(envelope: LifecycleEnvelope) => void>();
  protected readonly sessions = new Map<string, BridgeSessionMetadata>();
  protected provider: BridgeProviderIdentity | null = null;
  protected capabilities: BridgeCapabilities | null = null;
  protected helloError: string | null = null;
  protected spawnError: string | null = null;
  protected exited: { code: number | null; signal: string | null } | null = null;
  // Set when the final SIGKILL grace expires without an observed exit.
  // The child may still be alive: `proc` is retained (never nulled) so a
  // later force-close can retry, and every shutdown path reports unsettled
  // instead of a success receipt until an exit is proven.
  protected exitUnproven = false;
  // One-shot exit observation re-armed whenever `proc` is retained across
  // a detach (transport error, unproven dispose). Disarmed by detachAll so
  // a stale watch can never attribute an old proc's exit to a fresh child.
  protected detachExitWatch: (() => void) | null = null;
  protected disposed = false;
  protected starting: Promise<BridgeSupport> | null = null;
  protected stderr = "";
  protected readonly maxStderr: number;


  constructor(protected readonly options: BridgeHostOptions) {
    if (!options.bridgeCommand || options.bridgeCommand.trim() === "") {
      throw new BridgeUnavailableError("bridge command is empty (set an explicit dev-only bridge path)", "BRIDGE_NO_COMMAND");
    }
    if (!options.workspaceRoot || options.workspaceRoot.trim() === "") {
      throw new BridgeUnavailableError("workspaceRoot is required", "BRIDGE_NO_WORKSPACE");
    }
    this.maxStderr = options.maxStderrBytes ?? MAX_STDERR_BYTES;
  }

  // -- observables -----------------------------------------------------------


  get isReady(): boolean {
    return this.provider !== null && this.proc !== null && !this.disposed && this.exited === null;
  }


  protected spawnProvider(): void {
    // A finalized dead child (see exit handler) leaves proc nulled so the
    // next explicit start spawns fresh. A live proc is reused.
    if (this.proc) {return;}
    // Default through the shared spawn chokepoint: it pins windowsHide, refuses shell:true,
    // and encodes .cmd/.bat arguments, so the helper never steals focus or mangles argv.
    const spawnFn: SpawnFn =
      this.options.spawnFn ??
      ((command, args, options) =>
        spawnProcess({
          program: command,
          args,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env ? { env: options.env } : {}),
          stdio: ["pipe", "pipe", "pipe"],
        }));
    const env = this.options.env ? { ...process.env, ...this.options.env } : { ...process.env };
    let proc: SpawnedProcess;
    try {
      proc = spawnFn(this.options.bridgeCommand, this.options.bridgeArgs ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
        env,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.spawnError = `spawn-failed: ${reason}`;
      throw new BridgeUnavailableError(sanitizeReason(this.spawnError), "BRIDGE_SPAWN_FAILED");
    }
    this.proc = proc;
    const stdout = proc.stdout as unknown as (NodeJS.ReadableStream & { on(event: string, listener: (...args: never[]) => void): unknown; off(event: string, listener: (...args: never[]) => void): unknown; destroy?: () => void }) | null;
    const stderr = proc.stderr as unknown as (NodeJS.ReadableStream & { on(event: string, listener: (...args: never[]) => void): unknown; off(event: string, listener: (...args: never[]) => void): unknown; destroy?: () => void }) | null;
    const stdin = proc.stdin as unknown as ({ on?(event: string, listener: (...args: never[]) => void): unknown; off?(event: string, listener: (...args: never[]) => void): unknown } | null);
    const onStderrData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.stderr += text;
      if (this.stderr.length > this.maxStderr * 2) {this.stderr = this.stderr.slice(-this.maxStderr);}
    };
    stderr?.on("data", onStderrData as (...args: never[]) => void);
    this.detachFns.push(() => {
      try {
        stderr?.off("data", onStderrData as (...args: never[]) => void);
      } catch {
        // Cleanup must not throw.
      }
    });
    this.detachReader = attachBridgeReader(proc.stdout as unknown as BridgeReadable, (line) => this.onLine(line));
    const detachStdoutReader = this.detachReader;
    this.detachFns.push(() => {
      try {
        detachStdoutReader();
      } catch {
        // Cleanup must not throw.
      }
    });
    // Async stream failures (e.g. EPIPE after the helper closes stdin)
    // surface via `error` events, never as synchronous write() throws.
    // Without these listeners they become uncaught exceptions; with them
    // they become shaped fail-closed bridge failures (same finalizer as a
    // child error). Guards inside ignore teardown races; minimal fake
    // stdins may be write-only `{write,end}` without an emitter.
    const onStdinError = (error: unknown): void => {
      this.terminateOnTransportError("stdin", error);
    };
    const onStdoutError = (error: unknown): void => {
      this.terminateOnTransportError("stdout", error);
    };
    const onStderrError = (error: unknown): void => {
      this.terminateOnTransportError("stderr", error);
    };
    const onChildError = (error: unknown): void => {
      this.terminateOnTransportError("child", error);
    };
    const onChildExit = (code: number | null, signal: string | null): void => {
      this.handleChildExit(code, signal);
    };
    try {
      stdin?.on?.("error", onStdinError as (...args: never[]) => void);
    } catch {
      // Ignore (write-only fake stdin).
    }
    try {
      stdout?.on?.("error", onStdoutError as (...args: never[]) => void);
    } catch {
      // Ignore.
    }
    try {
      stderr?.on?.("error", onStderrError as (...args: never[]) => void);
    } catch {
      // Ignore.
    }
    proc.on("error", onChildError);
    proc.on("exit", onChildExit);
    const off = (emitter: { off?(event: string, listener: (...args: never[]) => void): unknown } | null | undefined, event: string, listener: (...args: never[]) => void): void => {
      try {
        emitter?.off?.(event, listener);
      } catch {
        // Cleanup must not throw.
      }
    };
    this.detachFns.push(() => off(stdin, "error", onStdinError as (...args: never[]) => void));
    this.detachFns.push(() => off(stdout as unknown as { off?(event: string, listener: (...args: never[]) => void): unknown } | null, "error", onStdoutError as (...args: never[]) => void));
    this.detachFns.push(() => off(stderr as unknown as { off?(event: string, listener: (...args: never[]) => void): unknown } | null, "error", onStderrError as (...args: never[]) => void));
    this.detachFns.push(() => off(proc as unknown as { off?(event: string, listener: (...args: never[]) => void): unknown }, "error", onChildError as (...args: never[]) => void));
    this.detachFns.push(() => off(proc as unknown as { off?(event: string, listener: (...args: never[]) => void): unknown }, "exit", onChildExit as (...args: never[]) => void));
  }

  /** Detach every listener attached in spawnProvider (reader, data, stdio/child errors, exit). Never throws. */

  protected detachAll(): void {
    try {
      this.detachExitWatch?.();
    } catch {
      // Cleanup must not throw.
    }
    this.detachExitWatch = null;
    const fns = this.detachFns.splice(0);
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // Cleanup must not throw.
      }
    }
    try {
      this.detachReader?.();
    } catch {
      // Ignore.
    }
    this.detachReader = null;
  }

  /**
   * Terminal transport failure without a guaranteed process exit (async
   * stdin/stdout/stderr `error`, or child `error` with no subsequent
   * `exit`). Invalidates provider/session ownership, detaches every
   * listener, best-effort SIGKills + destroys stdio while the failing proc
   * is still reachable. The exit stays unproven — no synthetic `exited`
   * record — and the child handle is retained, so a later teardown waits
   * for a real exit (or rejects BRIDGE_EXIT_UNPROVEN) instead of spending
   * a success receipt for a helper that may still be alive. A later real
   * `exit` on the retained proc still settles teardown normally.
   * In-flight dispatches resolve `unknown` (the write may or may not have
   * landed); post-failure dispatch rejects `bridge-unavailable` until
   * explicit restart/probe. Idempotent: repeats while unproven re-kill
   * without further state change. Diagnostics carry only the stream
   * name + OS message (never prompt text or env).
   */

  protected requestTimeout(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Per-session response correlation: every session-scoped provider reply
   * must name the requested session. opId alone is not enough — a
   * stale/buggy provider could otherwise cross-wire concurrent structured
   * sessions (e.g. history entries from session B returned for session A,
   * where the host strips the response identity and the caller could never
   * detect it). Mismatches never poison host state.
   */

  protected sendAndWait(message: HostToProviderMessage, timeoutMs: number): Promise<ProviderToHostMessage> {
    const proc = this.proc;
    if (!proc?.stdin) {throw new BridgeUnavailableError("provider process has no stdin", "BRIDGE_NO_STDIN");}
    assertNoCredentialFields(message, message.kind);
    if (typeof message.opId !== "string" || message.opId === "") {
      throw new BridgeUnavailableError(`missing opId for ${message.kind}`, "BRIDGE_NO_OP");
    }
    return new Promise<ProviderToHostMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.opId as string);
        reject(new Error(`timed out waiting for ${message.kind} opId=${message.opId}`));
      }, timeoutMs);
      this.pending.set(message.opId as string, { kind: message.kind, resolve, reject, timer });
      try {
        (proc.stdin as unknown as { write(s: string): void }).write(serializeBridgeLine(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.opId as string);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }


  protected onLine(line: string): void {
    if (line.trim() === "") {return;}
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed provider line: ignore (robustness), do not crash the host.
      // Dispatch waiters stay pending until their deadline → `unknown`.
      return;
    }
    if (validateBridgeMessage(parsed) !== null) {return;}
    const msg = parsed as ProviderToHostMessage;
    if (msg.kind === "session_event") {
      const envelope: SessionEventEnvelope = {
        sessionId: msg.sessionId,
        ...(msg.opId ? { opId: msg.opId } : {}),
        event: msg.event,
      };
      // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
      for (const listener of [...this.sessionListeners]) {
        try {
          listener(envelope);
        } catch {
          // Listener failures never break the bridge reader.
        }
      }
      return;
    }
    if (msg.kind === "exiting" || msg.kind === "error") {
      const isBenignAnswerAck = msg.kind === "error" && msg.error.code === "ANSWERED";
      if (!isBenignAnswerAck) {
        this.emitLifecycle({
          kind: msg.kind === "exiting" ? "provider-exit" : "provider-error",
          message: sanitizeReason(msg.kind === "exiting" ? `provider exiting: ${msg.reason}` : `provider error: ${msg.error.code}`),
          ...(msg.kind === "exiting" ? { code: msg.exit.code, signal: msg.exit.signal } : {}),
        });
      }
      const opId = msg.opId;
      if (opId && this.pending.has(opId)) {
        const entry = this.pending.get(opId);
        if (entry) {
          this.pending.delete(opId);
          clearTimeout(entry.timer);
          if (entry.kind === "dispatch") {
            const sid = msg.kind === "error" ? (msg.sessionId ?? "") : "";
            entry.resolve({ v: 1, kind: "dispatch_ack", opId, sessionId: sid, status: "unknown", reason: "provider-error" } as DispatchAck);
          } else if (entry.kind === "answer_prompt" && isBenignAnswerAck) {
            // Benign ack for answer_prompt (see provider onAnswer): the turn
            // continues via session_event; resolve so the host never hangs.
            entry.resolve(msg);
          } else {
            entry.reject(new BridgeUnavailableError(`provider error before ${entry.kind}`, "BRIDGE_PROVIDER_ERROR"));
          }
        }
      }
      return;
    }
    const opId = (msg as { opId?: string }).opId;
    if (opId && this.pending.has(opId)) {
      const entry = this.pending.get(opId);
      if (entry) {
        this.pending.delete(opId);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
      return;
    }
    if (msg.kind === "closed") {
      const closed = msg as ClosedResponse;
      this.emitLifecycle({ kind: "bridge-closed", message: `provider closed code=${closed.exit.code}`, code: closed.exit.code, signal: closed.exit.signal });
    }
  }


  protected failAllPending(error: Error): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: entries are deleted during iteration
    for (const [opId, entry] of [...this.pending]) {
      this.pending.delete(opId);
      clearTimeout(entry.timer);
      if (entry.kind === "dispatch") {
        entry.resolve({ v: 1, kind: "dispatch_ack", opId, sessionId: "", status: "unknown", reason: "provider-exited" } as DispatchAck);
      } else {
        entry.reject(error);
      }
    }
  }


  protected emitLifecycle(envelope: LifecycleEnvelope): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
    for (const listener of [...this.lifecycleListeners]) {
      try {
        listener(envelope);
      } catch {
        // Ignore listener failures.
      }
    }
  }


  protected killGraceMs(): number {
    return this.options.killGraceMs ?? this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  }

  /**
   * One-shot exit observation for a retained child whose spawn-time exit
   * listener was detached (transport error, unproven dispose). A real exit
   * is proof of death, so it settles teardown via handleChildExit even
   * outside a shutdown wait. Self-removing on fire; disarmed by detachAll
   * so a stale watch never attributes an old proc's exit to a fresh child.
   * Never throws (fakes may lack an emitter; shutdown waits observe exits
   * through their own listener regardless).
   */
}
