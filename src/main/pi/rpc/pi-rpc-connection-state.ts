// Vendored transport state for SNC1.9 native Pi (mechanical split of
// 44madfire/orca-pi `packages/pi-rpc/src/connection.ts`, MIT).
//
// The upstream `PiRpcConnection` class is split across this file plus
// `pi-rpc-connection-startup`, `-records`, `-requests`, `-commands`, and
// `pi-rpc-connection` (protected-subclass chain, one class per file) so each
// file meets the line budget. Concatenated in chain order, bodies match
// upstream verbatim except for the Orca adaptations noted per file.
// Orca-side adaptations in this file: `ChildProcess` becomes Orca's
// `SpawnedProcess` (the same Node type via the child-process chokepoint) so
// no `node:child_process` import trips the import boundary; `commandNameOf`
// and `CLOSE_TERM_GRACE_MS` are exported for the sibling chunks.

import { JsonlFramer } from "./pi-jsonl-framing";
import { STDERR_TAIL_MAX_CHARS, redactStderrTail, type PiRpcError } from "./pi-rpc-errors";
import type { SpawnedProcess } from "../../../shared/child-process/process-spec";
import type {
  PiExtensionUiRequest,
  PiResponse,
  PiServerEvent,
} from "./pi-wire-protocol";

export type PiRpcSpawnFn = (
  command: string,
  args: string[],
  options: { stdio: string[]; cwd?: string; env?: NodeJS.ProcessEnv },
) => SpawnedProcess;

export type PiRpcConnectionOptions = {
  /** Pi executable (default `"pi"`). */
  readonly piCommand?: string;
  /**
   * Extra argv before `--mode rpc` (provider/model/thinking/session …).
   *
   * Prefer passing an already-resolved spec from core's `buildPiLaunch()`
   * (the single profile compiler) through `toPiRpcProcessSpec()` rather
   * than hand-building argv here, so JEF-7 prompt collision/path semantics
   * are preserved. `--mode rpc` is appended idempotently when missing.
   * See `launch.ts` for the single-compiler rule.
   */
  readonly piArgs?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Default per-request deadline (default 30s). */
  readonly defaultTimeoutMs?: number;
  /** Spawn/startup classification window (default 15s outer, 50ms grace). */
  readonly startupTimeoutMs?: number;
  /**
   * Verify RPC readiness during `start()` with a bounded internal
   * `get_state` round-trip (default true). When false, `start()` resolves
   * after OS spawn classification only (unit-test framing mode; not for
   * production use — early Pi failures would surface as `process-exited`
   * instead of `startup-failed`).
   */
  readonly startupProbe?: boolean;
  /** Deadline for the internal startup probe (default min(5s, remainder)). */
  readonly startupProbeTimeoutMs?: number;
  /** Stderr ring-buffer bound in chars (default 16_384). */
  readonly stderrMaxBytes?: number;
  readonly spawnFn?: PiRpcSpawnFn;
  /** Id factory (tests inject determinism; default `r1`, `r2`, …). */
  readonly generateId?: () => string;
}

export type PiRpcRequestOptions = {
  /** Override the default deadline for this request. */
  readonly timeoutMs?: number;
}

export type PiRpcCloseResult = {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** True when SIGTERM/SIGKILL was required (grace expired). */
  readonly forced: boolean;
}

export type PiRpcCloseOptions = {
  /**
   * Kill-first force semantics: SIGKILL immediately (no stdin EOF, no
   * SIGTERM), then a NON-ZERO bounded observation window for the OS `exit`.
   * Unobserved stays `{null, null}` (unknown). Callers must pass a real
   * grace — `close(0, { force: true })` still cannot observe a real child.
   */
  readonly force?: boolean;
}

export type PiRpcEventHandler<T = unknown> = (payload: T) => void;

type PendingEntry = {
  readonly command: string;
  readonly resolve: (response: PiResponse) => void;
  readonly reject: (error: PiRpcError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STDERR_MAX = 16_384;
export const CLOSE_TERM_GRACE_MS = 2_000;

function defaultIdFactory(): () => string {
  let n = 0;
  return () => `r${++n}`;
}

export function commandNameOf(cmd: Record<string, unknown>): string {
  return typeof cmd["type"] === "string" ? (cmd["type"] as string) : "<unknown>";
}

export class PiRpcConnectionState {
  protected proc: SpawnedProcess | null = null;
  protected readonly framer = new JsonlFramer();
  protected stderrRaw = "";
  protected readonly pending = new Map<string, PendingEntry>();
  protected readonly eventHandlers = new Set<PiRpcEventHandler<PiServerEvent>>();
  protected readonly responseHandlers = new Set<PiRpcEventHandler<PiResponse>>();
  protected readonly extensionUiHandlers = new Set<PiRpcEventHandler<PiExtensionUiRequest>>();
  protected readonly malformedHandlers = new Set<
    PiRpcEventHandler<{ linePreview: string; count: number }>
  >();
  protected readonly exitHandlers = new Set<PiRpcEventHandler<PiRpcCloseResult>>();
  protected readonly settledWaiters: {
    resolve: () => void;
    reject: (error: PiRpcError) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  protected readonly generateId: () => string;
  protected readonly defaultTimeoutMs: number;
  protected readonly startupTimeoutMs: number;
  protected readonly startupProbe: boolean;
  protected readonly startupProbeTimeoutMs: number | undefined;
  protected readonly stderrMaxBytes: number;
  protected started = false;
  protected closed = false;
  protected closing = false;
  /** True while the OS-spawn phase of start() owns child exit/error. */
  protected startingPhase1 = false;
  protected exitInfo: PiRpcCloseResult | null = null;
  protected malformedCount = 0;
  protected unmatchedCount = 0;
  protected readonly detachFns: (() => void)[] = [];

  constructor(protected readonly options: PiRpcConnectionOptions = {}) {
    this.generateId = options.generateId ?? defaultIdFactory();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.startupProbe = options.startupProbe ?? true;
    this.startupProbeTimeoutMs = options.startupProbeTimeoutMs;
    this.stderrMaxBytes = options.stderrMaxBytes ?? DEFAULT_STDERR_MAX;
  }

  get isStarted(): boolean {
    return this.started && !this.closed;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get malformedLineCount(): number {
    return this.malformedCount;
  }

  get unmatchedResponseCount(): number {
    return this.unmatchedCount;
  }

  /** Bounded, redacted stderr tail (safe for logs/diagnostics). */
  get stderrTail(): string {
    return redactStderrTail(this.stderrRaw.slice(-this.stderrMaxBytes), STDERR_TAIL_MAX_CHARS);
  }
}
