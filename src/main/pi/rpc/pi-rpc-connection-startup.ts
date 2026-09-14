// Vendored Pi RPC startup for SNC1.9 native Pi (mechanical split of
// 44madfire/orca-pi `packages/pi-rpc/src/connection.ts`, MIT; see
// `pi-rpc-connection-state.ts` for the split contract).
//
// Orca-side adaptations in this file: the default spawn path uses Orca's
// single child-process chokepoint (`spawnProcess`, detached POSIX group for
// tree termination) instead of `node:child_process` `spawn`.

import { spawnProcess } from "../../../shared/child-process/run-process";
import type { SpawnedProcess } from "../../../shared/child-process/process-spec";
import { PiRpcError } from "./pi-rpc-errors";
import {
  PiRpcConnectionState,
  type PiRpcRequestOptions,
} from "./pi-rpc-connection-state";
import type { PiCommand, PiResponse } from "./pi-wire-protocol";

const DEFAULT_STARTUP_PROBE_TIMEOUT_MS = 5_000;
const STARTUP_GRACE_MS = 50;

function orcaDefaultSpawnFn(
  command: string,
  args: string[],
  options: { stdio: string[]; cwd?: string; env?: NodeJS.ProcessEnv },
): SpawnedProcess {
  return spawnProcess({
    program: command,
    args,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  }) as SpawnedProcess;
}

export abstract class PiRpcConnectionStartup extends PiRpcConnectionState {
  // Implemented by a later chunk: spawning attaches framing here, and the
  // readiness probe issues its `get_state` through request correlation.
  protected abstract attach(proc: SpawnedProcess): void;
  protected abstract requestRaw(
    command: PiCommand,
    opts?: PiRpcRequestOptions,
  ): Promise<PiResponse>;

  /**
   * Spawn `pi --mode rpc` and attach strict LF-only framing.
   *
   * Classifies startup failures: spawn errors (ENOENT/EACCES → helpful
   * `spawn-failed`), early non-zero exits (`startup-failed` with stderr
   * tail), and outer timeouts (`startup-timeout`). Readiness is gated on a
   * real RPC round-trip (bounded internal `get_state` probe) unless
   * `startupProbe: false`: in Node, `spawn` only means the OS process was
   * created, so a Pi invocation with invalid args/config can emit `spawn`
   * and then exit non-zero on the next turn. Without the probe, `start()`
   * would resolve on `spawn` and the early exit would surface only as a
   * steady-state `process-exited`. Never leaks the child on failure (kills
   * + detaches before throwing).
   */
  async start(): Promise<void> {
    if (this.closed) {
      throw new PiRpcError(
        { code: "already-closed", ambiguous: false },
        "PiRpcConnection is closed and cannot be restarted; construct a new instance",
      );
    }
    if (this.proc) {
      throw new PiRpcError(
        { code: "already-started", ambiguous: false },
        "PiRpcConnection already started",
      );
    }
    const command = this.options.piCommand ?? "pi";
    // Idempotent `--mode rpc`: callers pass `toPiRpcProcessSpec()` args
    // (which already end with `--mode rpc`) or raw extra args (which the
    // connection completes). Never emit the flag twice.
    const extra = [...(this.options.piArgs ?? [])];
    const hasMode = extra.some((a, i) => a === "--mode" && extra[i + 1] === "rpc");
    const args = hasMode ? extra : [...extra, "--mode", "rpc"];
    const spawnFn = this.options.spawnFn ?? orcaDefaultSpawnFn;
    let proc: SpawnedProcess;
    try {
      proc = spawnFn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
        ...(this.options.env !== undefined ? { env: this.options.env } : {}),
      });
    } catch (error) {
      throw new PiRpcError(
        { code: "spawn-failed", ambiguous: false, stderrTail: this.stderrTail },
        `failed to spawn ${command}: ${(error as Error).message}`,
      );
    }
    this.proc = proc;
    this.attach(proc);
    const startWall = Date.now();

    // Phase 1 — OS spawn classification: resolve on `spawn`, reject on
    // `error`/early `exit`, assume success after a short grace (covers
    // fake processes in tests that emit neither), bound by the outer
    // startup timeout. Phase 1 alone cannot prove Pi is speaking RPC
    // (spawn fires before invalid args/config fail), so phase 2 probes.
    // Steady-state exit/error handlers defer to this phase while
    // `startingPhase1` is set; stdio errors still finalize immediately and
    // are reclassified below via the post-phase-1 closed check.
    type OnceCapable = { once(event: string, listener: (...args: never[]) => void): unknown; off?(event: string, listener: (...args: never[]) => void): unknown; removeListener?(event: string, listener: (...args: never[]) => void): unknown };
    const procOnce = proc as unknown as OnceCapable;
    let onSpawn: (...args: never[]) => void = () => undefined;
    let onPhaseError: (...args: never[]) => void = () => undefined;
    let onEarlyExit: (...args: never[]) => void = () => undefined;
    this.startingPhase1 = true;
    try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) {return;}
        settled = true;
        clearTimeout(grace);
        clearTimeout(outer);
        fn();
      };
      onSpawn = (): void => done(resolve);
      onPhaseError = (error: unknown): void =>
        done(() => {
          this.detachAndKill();
          const msg = (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `failed to spawn ${command}: not found on PATH (${(error as Error).message})`
            : `failed to spawn ${command}: ${(error as Error).message}`;
          reject(new PiRpcError({ code: "spawn-failed", ambiguous: false }, msg));
        });
      onEarlyExit = (code: unknown, signal: unknown): void =>
        done(() => {
          this.detachAndKill();
          reject(
            new PiRpcError(
              {
                code: "startup-failed",
                ambiguous: false,
                exitCode: code as number | null,
                signal: signal as string | null,
                stderrTail: this.stderrTail,
              },
              `pi exited during startup (code=${String(code)} signal=${String(signal)})${ 
                this.stderrTail ? `: ${this.stderrTail}` : ""}`,
            ),
          );
        });
      const grace = setTimeout(() => done(resolve), STARTUP_GRACE_MS);
      const outer = setTimeout(
        () =>
          done(() => {
            this.detachAndKill();
            reject(
              new PiRpcError(
                {
                  code: "startup-timeout",
                  ambiguous: false,
                  timeoutMs: this.startupTimeoutMs,
                  stderrTail: this.stderrTail,
                },
                `pi did not start within ${this.startupTimeoutMs}ms`,
              ),
            );
          }),
        this.startupTimeoutMs,
      );
      // `once` keeps startup listeners out of the steady-state set; the
      // persistent exit/error handlers are attached in `attach()`.
      procOnce.once?.("spawn", onSpawn);
      procOnce.once?.("error", onPhaseError);
      procOnce.once?.("exit", onEarlyExit);
      // If the process already failed synchronously (fake `error` emitted
      // before `once` attached), the persistent handler in `attach()` will
      // have recorded it — re-check on the next tick via grace resolution.
    });
    } finally {
      this.startingPhase1 = false;
      // Phase-1 `once` listeners that never fired (e.g. `spawn` on fakes)
      // must not linger into steady state.
      try {
        if (typeof procOnce.off === "function") {
          procOnce.off("spawn", onSpawn);
          procOnce.off("error", onPhaseError);
          procOnce.off("exit", onEarlyExit);
        } else if (typeof procOnce.removeListener === "function") {
          procOnce.removeListener("spawn", onSpawn);
          procOnce.removeListener("error", onPhaseError);
          procOnce.removeListener("exit", onEarlyExit);
        }
      } catch {
        // Cleanup must not throw.
      }
    }
    // A stdio failure during phase 1 finalizes the transport immediately
    // (phase 1 only watches spawn/error/exit); reclassify for startup.
    if (this.closed) {
      throw new PiRpcError(
        {
          code: "startup-failed",
          ambiguous: false,
          exitCode: this.exitInfo?.exitCode,
          signal: this.exitInfo?.signal,
          stderrTail: this.stderrTail,
        },
        `pi transport failed during startup${  this.stderrTail ? `: ${this.stderrTail}` : ""}`,
      );
    }

    // Phase 2 — RPC readiness probe (unless explicitly disabled for
    // framing-only unit tests). A bounded internal `get_state` round-trip
    // proves Pi is actually speaking RPC; an exit before/during the probe
    // becomes `startup-failed` and a silent process becomes
    // `startup-timeout`. Any well-formed response (even `success: false`)
    // proves liveness — the bridge re-reads state itself afterwards.
    if (!this.startupProbe) {
      this.started = true;
      return;
    }
    const elapsed = Date.now() - startWall;
    const remaining = this.startupTimeoutMs - elapsed;
    if (remaining <= 0) {
      this.detachAndKill();
      throw new PiRpcError(
        {
          code: "startup-timeout",
          ambiguous: false,
          timeoutMs: this.startupTimeoutMs,
          stderrTail: this.stderrTail,
        },
        `pi did not become ready within ${this.startupTimeoutMs}ms`,
      );
    }
    const probeTimeout = Math.min(
      this.startupProbeTimeoutMs ?? DEFAULT_STARTUP_PROBE_TIMEOUT_MS,
      remaining,
    );
    try {
      await this.requestRaw({ type: "get_state" }, { timeoutMs: probeTimeout });
    } catch (error) {
      if (error instanceof PiRpcError && error.code === "rejected") {
        // Pi answered (with a rejection) → the transport is live.
      } else if (
        error instanceof PiRpcError &&
        (error.code === "process-exited" || error.code === "transport-closed")
      ) {
        // handleExit() already rejected the probe as ambiguous and (for
        // unexpected death) finalized the connection; reclassify for
        // startup callers who never got a ready connection.
        throw new PiRpcError(
          {
            code: "startup-failed",
            ambiguous: false,
            exitCode: error.exitCode,
            signal: error.signal,
            stderrTail: this.stderrTail,
          },
          `pi exited before RPC readiness ` +
            `(code=${String(error.exitCode)} signal=${String(error.signal)})${ 
            this.stderrTail ? `: ${this.stderrTail}` : ""}`,
        );
      } else if (error instanceof PiRpcError && error.code === "request-timeout") {
        this.detachAndKill();
        throw new PiRpcError(
          {
            code: "startup-timeout",
            ambiguous: false,
            timeoutMs: probeTimeout,
            stderrTail: this.stderrTail,
          },
          `pi did not answer RPC readiness probe within ${probeTimeout}ms`,
        );
      } else if (error instanceof PiRpcError && error.code === "write-failed") {
        this.detachAndKill();
        throw new PiRpcError(
          {
            code: "startup-failed",
            ambiguous: false,
            stderrTail: this.stderrTail,
          },
          `pi transport failed before RPC readiness: ${error.message}`,
        );
      } else {
        this.detachAndKill();
        throw error;
      }
    }

    this.started = true;
  }


  protected detachAll(): void {
    const fns = this.detachFns.splice(0);
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // Cleanup must not throw.
      }
    }
  }


  protected detachAndKill(signal: NodeJS.Signals = "SIGKILL"): void {
    const proc = this.proc;
    this.detachAll();
    if (proc) {
      try {
        if (proc.exitCode === null && proc.signalCode === undefined) {proc.kill(signal);}
      } catch {
        // Already dead.
      }
      try {
        proc.stdout?.destroy?.();
      } catch {
        // Ignore.
      }
      try {
        proc.stderr?.destroy?.();
      } catch {
        // Ignore.
      }
    }
    this.proc = null;
  }

  // -------------------------------------------------------------------------
  // Incoming records
  // -------------------------------------------------------------------------
}
