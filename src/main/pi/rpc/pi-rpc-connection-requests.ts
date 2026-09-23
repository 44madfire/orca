// Vendored Pi RPC request correlation for SNC1.9 native Pi (mechanical split
// of 44madfire/orca-pi `packages/pi-rpc/src/connection.ts`, MIT; see
// `pi-rpc-connection-state.ts` for the split contract).
//
// Orca-side adaptations in this file: none beyond the mechanical
// `private` → `protected` and `ChildProcess` → `SpawnedProcess` renames.

import { PiRpcError, rejectedError } from "./pi-rpc-errors";
import { serializeJsonLine } from "./pi-jsonl-framing";
import { PiRpcConnectionRecords } from "./pi-rpc-connection-records";
import {
  commandNameOf,
  type PiRpcCloseResult,
  type PiRpcEventHandler,
  type PiRpcRequestOptions,
} from "./pi-rpc-connection-state";
import type {
  PiCommand,
  PiExtensionUiRequest,
  PiResponse,
  PiServerEvent,
} from "./pi-wire-protocol";
import type { PiFamilyReadyInfo } from "./pi-family-rpc-types";
import type { SpawnedProcess } from "../../../shared/child-process/process-spec";

export abstract class PiRpcConnectionRequests extends PiRpcConnectionRecords {

  /** Subscribe to every async server event (non-response `s2c`). */
  onEvent(handler: PiRpcEventHandler<PiServerEvent>): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }


  /** Subscribe to every wire response (matched or not). */
  onResponse(handler: PiRpcEventHandler<PiResponse>): () => void {
    this.responseHandlers.add(handler);
    return () => {
      this.responseHandlers.delete(handler);
    };
  }


  /** Subscribe to `extension_ui_request` records only. */
  onExtensionUiRequest(handler: PiRpcEventHandler<PiExtensionUiRequest>): () => void {
    this.extensionUiHandlers.add(handler);
    return () => {
      this.extensionUiHandlers.delete(handler);
    };
  }


  /** Subscribe to the OMP `ready` advertisement (once per connection). */
  onReady(handler: PiRpcEventHandler<PiFamilyReadyInfo>): () => void {
    this.readyHandlers.add(handler);
    return () => {
      this.readyHandlers.delete(handler);
    };
  }

  /** Subscribe to malformed stdout lines (framing diagnostics). */
  onMalformedLine(
    handler: PiRpcEventHandler<{ linePreview: string; count: number }>,
  ): () => void {
    this.malformedHandlers.add(handler);
    return () => {
      this.malformedHandlers.delete(handler);
    };
  }


  /** Subscribe to process exit (fires once per connection). */
  onExit(handler: PiRpcEventHandler<PiRpcCloseResult>): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }


  /** Remove every subscription (also done by `close()`). */
  removeAllListeners(): void {
    this.eventHandlers.clear();
    this.responseHandlers.clear();
    this.extensionUiHandlers.clear();
    this.malformedHandlers.clear();
    this.readyHandlers.clear();
    this.exitHandlers.clear();
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------


  protected ensureWritable(): SpawnedProcess {
    const proc = this.proc;
    if (this.closed || this.closing) {
      throw new PiRpcError(
        { code: "transport-closed", ambiguous: true, stderrTail: this.stderrTail },
        "Pi RPC transport is closed",
      );
    }
    if (!proc?.stdin) {
      throw new PiRpcError(
        { code: "not-started", ambiguous: false },
        "PiRpcConnection not started; call start() first",
      );
    }
    return proc;
  }


  /**
   * Send a correlated request and resolve with the full wire response.
   *
   * Resolves on `success: true`, throws `rejected` (`ambiguous: false`) on
   * `success: false`, and throws `request-timeout` / `process-exited` /
   * `transport-closed` (`ambiguous: true`) when the outcome is unknown.
   * Responses interleaved with unrelated events correlate by `id`, never by
   * arrival order. Errors carry only the command name + id (never the full
   * payload, prompt text, or image bytes).
   */
  requestRaw(
    command: PiCommand,
    opts: PiRpcRequestOptions = {},
  ): Promise<PiResponse> {
    const proc = this.ensureWritable();
    const name = commandNameOf(command);
    const id = command.id ?? this.freshId();
    const payload = { ...command, id };
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) {return;}
        this.pending.delete(id);
        reject(
          new PiRpcError(
            {
              code: "request-timeout",
              command: name,
              requestId: id,
              ambiguous: true,
              timeoutMs,
              stderrTail: this.stderrTail,
            },
            `timed out after ${timeoutMs}ms waiting for ${name} (id=${id}); ` +
              `outcome is ambiguous — re-read state before retrying`,
          ),
        );
      }, timeoutMs);
      // Unref so an idle connection never holds the event loop open.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.pending.set(id, {
        command: name,
        resolve,
        reject,
        timer,
      });
      try {
        proc.stdin!.write(serializeJsonLine(payload));
      } catch (error) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          if (entry.timer) {clearTimeout(entry.timer);}
        }
        reject(
          new PiRpcError(
            { code: "write-failed", command: name, requestId: id, ambiguous: true },
            `failed to write ${name} (id=${id}): ${(error as Error).message}`,
          ),
        );
      }
    }).then((res) => {
      if (!res.success) {
        throw rejectedError(name, res.id, res.error ?? "unknown error", this.stderrTail);
      }
      return res;
    });
  }


  /**
   * Send a correlated request and resolve with its `data` (or `undefined`
   * when Pi omits it, e.g. `prompt` accept). Rejection semantics match
   * `requestRaw`.
   */
  async request<T = unknown>(command: PiCommand, opts: PiRpcRequestOptions = {}): Promise<T> {
    const res = await this.requestRaw(command, opts);
    return res.data as T;
  }


  protected freshId(): string {
    for (;;) {
      const id = this.generateId();
      if (!this.pending.has(id)) {return id;}
    }
  }


  /** Fire-and-forget write (no response expected, e.g. UI responses). */
  sendNotification(payload: Record<string, unknown>): void {
    const proc = this.ensureWritable();
    try {
      proc.stdin!.write(serializeJsonLine(payload));
    } catch (error) {
      throw new PiRpcError(
        {
          code: "write-failed",
          command: commandNameOf(payload),
          ambiguous: false,
        },
        `failed to write ${commandNameOf(payload)}: ${(error as Error).message}`,
      );
    }
  }


  /** Write raw bytes (malformed-input probes; tests + diagnostics only). */
  sendRaw(text: string): void {
    const proc = this.ensureWritable();
    try {
      proc.stdin!.write(text);
    } catch (error) {
      throw new PiRpcError(
        { code: "write-failed", ambiguous: true },
        `failed to write raw bytes: ${(error as Error).message}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Typed wrappers for the protocol proven in #11.
  // -------------------------------------------------------------------------
}
