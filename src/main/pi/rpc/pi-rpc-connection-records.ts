// Vendored Pi RPC record handling for SNC1.9 native Pi (mechanical split of
// 44madfire/orca-pi `packages/pi-rpc/src/connection.ts`, MIT; see
// `pi-rpc-connection-state.ts` for the split contract).
//
// Orca-side adaptations in this file: none beyond the mechanical
// `private` → `protected` and `ChildProcess` → `SpawnedProcess` renames.

import { PiRpcError, boundTail, redactLinePreview } from "./pi-rpc-errors";
import { PiRpcConnectionStartup } from "./pi-rpc-connection-startup";
import { isOmpChunkFrame, isOmpReadyFrame } from "./pi-family-rpc-types";
import type { SpawnedProcess } from "../../../shared/child-process/process-spec";
import type { PiRpcCloseResult } from "./pi-rpc-connection-state";
import {
  isExtensionUiRequest,
  isPiResponse,
  type PiResponse,
  type PiServerEvent,
} from "./pi-wire-protocol";

/**
 * Metadata-only chunk-violation preview: the base64 payload (up to 256 KiB
 * of oversized-frame bytes) never reaches diagnostics, where
 * redactSecrets could not scrub it.
 */
function chunkViolationPreview(value: unknown, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  if (!isOmpChunkFrame(value)) {
    return `{"type":"rpc_chunk","interrupted":true,"error":${JSON.stringify(reason)}}`;
  }
  return (
    `{"type":"rpc_chunk","chunkId":${JSON.stringify(value.chunkId)},` +
    `"index":${JSON.stringify(value.index)},"count":${JSON.stringify(value.count)},` +
    `"byteLength":${JSON.stringify(value.byteLength)},"error":${JSON.stringify(reason)}}`
  );
}

export abstract class PiRpcConnectionRecords extends PiRpcConnectionStartup {
  // Implemented by later chunks: unexpected exits notify through the closer,
  // and record handling releases subscriptions owned by request correlation.
  protected abstract handleExit(code: number | null, signal: string | null): void;
  abstract removeAllListeners(): void;

  protected attach(proc: SpawnedProcess): void {
    type Eventable = {
      on(event: string, listener: (...args: never[]) => void): unknown;
      off?(event: string, listener: (...args: never[]) => void): unknown;
      removeListener?(event: string, listener: (...args: never[]) => void): unknown;
    };
    const stdin = proc.stdin as unknown as Eventable | null;
    const stdout = proc.stdout as unknown as Eventable | null;
    const stderr = proc.stderr as unknown as Eventable | null;
    const procEvents = proc as unknown as Eventable;

    const off = (
      target: {
        off?: (e: string, l: (...args: never[]) => void) => unknown;
        removeListener?: (e: string, l: (...args: never[]) => void) => unknown;
      } | null,
      event: string,
      listener: (...args: never[]) => void,
    ): void => {
      const t = target as {
        off?: (e: string, l: (...args: never[]) => void) => void;
        removeListener?: (e: string, l: (...args: never[]) => void) => void;
      } | null;
      if (!t) {return;}
      if (typeof t.off === "function") {t.off(event, listener);}
      else if (typeof t.removeListener === "function") {t.removeListener(event, listener);}
    };

    const onStdoutData = (chunk: unknown): void => {
      const lines = this.framer.push(chunk as Buffer);
      for (const line of lines) {this.handleLine(line);}
    };
    const onStdoutEnd = (): void => {
      for (const line of this.framer.finish()) {this.handleLine(line);}
    };
    const onStderrData = (chunk: unknown): void => {
      const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
      this.stderrRaw += text;
      if (this.stderrRaw.length > this.stderrMaxBytes * 2) {
        this.stderrRaw = this.stderrRaw.slice(-this.stderrMaxBytes);
      }
    };
    // Async stream failures (e.g. EPIPE after Pi closes stdin) surface via
    // `error` events, never as synchronous `write()` throws. Without these
    // listeners they become uncaught exceptions; with them they become
    // secret-safe ambiguous transport failures (see
    // `terminateOnTransportError`). Guards inside ignore teardown races.
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
      // Phase-1 startup owns child errors via its `once` listener (which
      // classifies them as `spawn-failed`); steady state must not double
      // handle. Node documents that `exit` may or may not follow `error`,
      // so steady state treats it as terminal without waiting for `exit`.
      if (this.startingPhase1) {return;}
      this.terminateOnTransportError("child", error);
    };
    const onExit = (code: number | null, signal: string | null): void => {
      this.handleExit(code, signal);
    };

    stdout?.on("data", onStdoutData as (...args: never[]) => void);
    stdout?.on("end", onStdoutEnd as (...args: never[]) => void);
    stderr?.on("data", onStderrData as (...args: never[]) => void);
    // `?.` capability checks: minimal fake stdins may be write-only
    // `{write, end}` objects without an emitter; sync throws in request
    // paths still classify failures for those.
    try {
      stdin?.on?.("error", onStdinError as (...args: never[]) => void);
    } catch {
      // Ignore.
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
    procEvents.on("error", onChildError as (...args: never[]) => void);
    procEvents.on("exit", onExit as (...args: never[]) => void);

    this.detachFns.push(() => off(stdout, "data", onStdoutData as (...args: never[]) => void));
    this.detachFns.push(() => off(stdout, "end", onStdoutEnd as (...args: never[]) => void));
    this.detachFns.push(() => off(stderr, "data", onStderrData as (...args: never[]) => void));
    this.detachFns.push(() => off(stdin, "error", onStdinError as (...args: never[]) => void));
    this.detachFns.push(() => off(stdout, "error", onStdoutError as (...args: never[]) => void));
    this.detachFns.push(() => off(stderr, "error", onStderrError as (...args: never[]) => void));
    this.detachFns.push(() => off(procEvents, "error", onChildError as (...args: never[]) => void));
    this.detachFns.push(() => off(procEvents, "exit", onExit as (...args: never[]) => void));
  }


  /**
   * Terminal transport failure without a process exit (async stdin/stdout/
   * stderr `error`, or a child `error` with no subsequent `exit`). Rejects
   * every in-flight request as ambiguous `transport-closed` (the write may
   * or may not have reached Pi), rejects settle waiters, notifies exit
   * listeners with synthesized facts, and funnels through the same
   * ownership release as unexpected exits — without depending on a later
   * `exit` that Node does not guarantee. Subsequent `exit`, if any, is a
   * no-op via the `closed` guard. Errors carry only the stream name + OS
   * message (never command payloads or prompt contents).
   */
  protected terminateOnTransportError(source: "stdin" | "stdout" | "stderr" | "child", error: unknown): void {
    if (this.closed || this.closing) {return;}
    const osMessage = boundTail(error instanceof Error ? error.message : String(error), 300);
    const tail = this.stderrTail;
    const exitInfo: PiRpcCloseResult = { exitCode: null, signal: null, forced: false };
    this.exitInfo = exitInfo;
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
            stderrTail: tail,
          },
          `pi transport ${source} failed before answering ${entry.command} (id=${id}): ${osMessage}${tail ? `: ${tail}` : ""}`,
        ),
      );
    }
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
    for (const h of [...this.exitHandlers]) {
      try {
        h(exitInfo);
      } catch {
        // Ignore.
      }
    }
    this.closed = true;
    const proc = this.proc;
    this.detachAll();
    // Best-effort kill so a still-alive child cannot leak after its stdio
    // broke; harmless when the process is already gone.
    try {
      proc?.kill("SIGKILL");
    } catch {
      // Already dead.
    }
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
    this.proc = null;
    this.removeAllListeners();
  }


  protected handleLine(line: string): void {
    if (line.trim() === "") {return;}
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.noteMalformed(line);
      return;
    }
    this.handleValue(value);
  }

  /** Route one parsed record; never a settlement predicate (see #25). */
  protected handleValue(value: unknown): void {
    // OMP `ready` never holds a correlation slot: record negotiation facts
    // and fan out as an ordinary async record (readiness still needs RPC).
    if (isOmpReadyFrame(value)) {
      this.observeReady(value);
      this.emitEvent(value);
      return;
    }
    // OMP `rpc_chunk` reassembles exactly once, bounded; violations are
    // malformed diagnostics, never connection crashes.
    if (isOmpChunkFrame(value) || this.chunkDecoder.hasPending) {
      let frame: object | undefined;
      try {
        frame = this.chunkDecoder.push(value);
      } catch (error) {
        this.chunkDecoder.reset();
        this.noteMalformed(chunkViolationPreview(value, error));
        return;
      }
      if (frame === undefined) {return;}
      this.handleValue(frame);
      return;
    }
    if (isPiResponse(value)) {
      this.handleResponse(value);
      return;
    }
    const event = value as PiServerEvent;
    this.emitEvent(event);
    if (isExtensionUiRequest(event)) {
      // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
      for (const h of [...this.extensionUiHandlers]) {
        try {
          h(event);
        } catch {
          // Ignore.
        }
      }
    }
  }


  /** Fan one async record out; unknown future shapes stay ignorable. */
  protected emitEvent(event: PiServerEvent): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
    for (const h of [...this.eventHandlers]) {
      try {
        h(event);
      } catch {
        // Listener errors never break framing.
      }
    }
  }

  /** Bound one malformed line; later valid records always survive. */
  protected noteMalformed(line: string): void {
    this.malformedCount += 1;
    const preview = redactLinePreview(line);
    const count = this.malformedCount;
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
    for (const h of [...this.malformedHandlers]) {
      try {
        h({ linePreview: preview, count });
      } catch {
        // Listener errors never break framing.
      }
    }
  }

  protected handleResponse(res: PiResponse): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
    for (const h of [...this.responseHandlers]) {
      try {
        h(res);
      } catch {
        // Ignore.
      }
    }
    if (res.id !== undefined) {
      const entry = this.pending.get(res.id);
      if (!entry) {
        this.unmatchedCount += 1;
        return;
      }
      this.pending.delete(res.id);
      if (entry.timer) {clearTimeout(entry.timer);}
      entry.resolve(res);
      return;
    }
    // Id-less responses (e.g. `command: "parse"` for malformed input) have
    // no waiter by construction — every `request()` carries an id. Surface
    // them to `onResponse` listeners (done above) and count them.
    this.unmatchedCount += 1;
  }

  protected closeWaiter: ((result: PiRpcCloseResult) => void) | null = null;
}
