// Vendored Pi RPC connection for SNC1.9 native Pi (mechanical split of
// 44madfire/orca-pi `packages/pi-rpc/src/connection.ts`, MIT; see
// `pi-rpc-connection-state.ts` for the split contract).
//
// `PiRpcConnection` is the public entry point: one `pi --mode rpc` child,
// strict LF-only JSONL, correlated requests with accepted/rejected/ambiguous
// semantics, and graceful/forced close. Orca-side adaptations in this file:
// none beyond the mechanical `private` → `protected` rename.

import { PiRpcError } from "./pi-rpc-errors";
import { PiRpcConnectionCommands } from "./pi-rpc-connection-commands";
import {
  CLOSE_TERM_GRACE_MS,
  type PiRpcCloseOptions,
  type PiRpcCloseResult,
} from "./pi-rpc-connection-state";
import type { PiExtensionUiResponse } from "./pi-wire-protocol";

export class PiRpcConnection extends PiRpcConnectionCommands {

  protected handleExit(code: number | null, signal: string | null): void {
    if (this.closed) {return;}
    // During close() the exit is expected: record facts and wake the
    // closer, but leave in-flight rejection + user notification to
    // finishClose() so every close-driven rejection is `transport-closed`
    // (ambiguous) and onExit fires exactly once. Only unexpected deaths
    // reject as `process-exited` here.
    if (this.closing) {
      this.exitInfo = { exitCode: code, signal, forced: this.exitInfo?.forced ?? true };
      this.closeWaiter?.(this.exitInfo);
      return;
    }
    // Record exit facts; `forced` is refined by close()/finishClose().
    this.exitInfo = { exitCode: code, signal, forced: this.exitInfo?.forced ?? false };
    const tail = this.stderrTail;
    // Every in-flight request becomes ambiguous: the write succeeded but Pi
    // died before answering, so callers cannot know if it was processed.
    const pendings = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, entry] of pendings) {
      if (entry.timer) {clearTimeout(entry.timer);}
      entry.reject(
        new PiRpcError(
          {
            code: "process-exited",
            command: entry.command,
            requestId: id,
            ambiguous: true,
            exitCode: code,
            signal,
            stderrTail: tail,
          },
          `pi exited before answering ${entry.command} (id=${id}, ` +
            `code=${String(code)} signal=${String(signal)})${
            tail ? `: ${tail}` : ""}`,
        ),
      );
    }
    // Unexpected death outside close(): funnel through the same
    // finalization as close() (no leaked children/listeners) while keeping
    // the `process-exited` ambiguity semantics established above. Notify
    // user listeners first, then release process ownership + subscriptions
    // so post-mortem assertions observe a fully cleaned-up transport.
    // `close()` afterwards returns the cached exit info immediately.
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
    for (const h of [...this.exitHandlers]) {
      try {
        h(this.exitInfo);
      } catch {
        // Ignore.
      }
    }
    this.closed = true;
    this.detachAll();
    const proc = this.proc;
    this.proc = null;
    try {
      proc?.stdout?.destroy?.();
    } catch {
      // Ignore.
    }
    try {
      proc?.stderr?.destroy?.();
    } catch {
      // Ignore.
    }
    this.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // Subscriptions (all return an unsubscribe fn; close() removes everything)
  // -------------------------------------------------------------------------


  /**
   * Reply to an `extension_ui_request` dialog. Fire-and-forget: no response
   * is expected (extension commands execute immediately, even mid-stream).
   * `cancelled: true` → the extension sees `undefined` (`false` for confirm).
   */
  respondToExtensionUi(response: PiExtensionUiResponse): void {
    this.sendNotification({ ...response });
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------


  /**
   * Graceful close (stdin EOF → Pi exits 0), then forced (SIGTERM →
   * SIGKILL) after `graceMs`. Rejects remaining in-flight requests as
   * ambiguous `transport-closed`, removes every listener, destroys stdio,
   * and never leaves a duplicate owner. Idempotent — repeat calls return the
   * same result. Safe to call when idle (no pending) or active (pending
   * rejected as ambiguous).
   *
   * Pass `{ force: true }` for kill-first force semantics (bridge
   * `close{force}`): SIGKILL immediately with no stdin EOF and no SIGTERM,
   * then a NON-ZERO bounded observation window for the OS `exit`. Unobserved
   * stays `{null, null}` (unknown) — never the graceful all-missed synthesis.
   * `close(0)` without force cannot observe a real child (all three races are
   * zero-length), so force callers must pass a real grace.
   */
  async close(graceMs = CLOSE_TERM_GRACE_MS, opts: PiRpcCloseOptions = {}): Promise<PiRpcCloseResult> {
    if (this.closed && this.exitInfo) {return this.exitInfo;}
    const proc = this.proc;
    if (!proc) {
      this.closed = true;
      this.exitInfo = { exitCode: null, signal: null, forced: false };
      this.removeAllListeners();
      return this.exitInfo;
    }
    this.closing = true;
    // Dedicated closer waiter (separate from user onExit listeners so
    // handleExit-during-close wakes only the closer; finishClose fires
    // user listeners exactly once).
    const exit = new Promise<PiRpcCloseResult>((resolve) => {
      this.closeWaiter = (result: PiRpcCloseResult): void => {
        this.closeWaiter = null;
        resolve(result);
      };
      if (proc.exitCode !== null || proc.signalCode != null) {
        const cached = this.exitInfo ?? {
          exitCode: proc.exitCode,
          signal: (proc.signalCode as string | null) ?? null,
          forced: false,
        };
        setTimeout(() => this.closeWaiter?.(cached), 0);
      }
    });
    const waitExit = (timeoutMs: number): Promise<PiRpcCloseResult | null> =>
      Promise.race([
        exit.then((r) => r as PiRpcCloseResult | null),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => resolve(null), timeoutMs);
          (t as unknown as { unref?: () => void }).unref?.();
        }),
      ]);

    const stopWaiting = (): void => {
      this.closeWaiter = null;
    };

    if (opts.force) {
      // Kill-first: SIGKILL immediately (no EOF, no SIGTERM), then observe.
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already exited; observation below reports whatever landed.
      }
      const seen = await waitExit(Math.max(graceMs, 1));
      stopWaiting();
      if (seen !== null) {return this.finishClose(seen.exitCode, seen.signal, true);}
      // Genuinely unobserved: preserve unknown, never fabricate clean/signal.
      return this.finishClose(null, null, true);
    }

    try {
      proc.stdin?.end();
    } catch {
      // Already closed; fall through to SIGTERM below.
    }

    let seen = await waitExit(graceMs);
    let forced = false;
    if (seen === null) {
      forced = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      // Bound every stage by the caller's grace so tests stay fast;
      // production callers pass the default 2s grace per stage.
      seen = await waitExit(graceMs);
    }
    if (seen === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      seen = await waitExit(graceMs);
    }
    stopWaiting();
    if (seen !== null) {
      return this.finishClose(seen.exitCode, seen.signal, forced);
    }
    // The process ignored EOF + SIGTERM + SIGKILL (fakes/stuck children):
    // synthesize a forced close so callers never hang. Best-effort kill
    // before giving up on the OS handle.
    try {
      proc.kill("SIGKILL");
    } catch {
      // Ignore.
    }
    return this.finishClose(proc.exitCode ?? null, (proc.signalCode as string | null) ?? "SIGKILL", true);
  }


  protected finishClose(
    exitCode: number | null,
    signal: string | null,
    forced: boolean,
  ): PiRpcCloseResult {
    const result: PiRpcCloseResult = { exitCode, signal, forced };
    this.exitInfo = result;
    this.closed = true;
    this.closing = false;
    // Remaining in-flight requests are ambiguous: Pi may have processed them
    // before EOF/kill, but the transport can no longer tell.
    const pendings = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, entry] of pendings) {
      if (entry.timer) {clearTimeout(entry.timer);}
      entry.reject(
        new PiRpcError(
          {
            code: "transport-closed",
            command: entry.command,
            requestId: id,
            ambiguous: true,
            exitCode,
            signal,
          },
          `transport closed before answering ${entry.command} (id=${id})`,
        ),
      );
    }
    this.detachAll();
    try {
      this.proc?.stdout?.destroy?.();
    } catch {
      // Ignore.
    }
    try {
      this.proc?.stderr?.destroy?.();
    } catch {
      // Ignore.
    }
    this.proc = null;
    // Fire exit handlers once (handleExit skips when `closed` during close).
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
    for (const h of [...this.exitHandlers]) {
      try {
        h(result);
      } catch {
        // Ignore.
      }
    }
    this.removeAllListeners();
    return result;
  }
}
