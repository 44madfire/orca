// Vendored Pi RPC typed commands for SNC1.9 native Pi (mechanical split of
// 44madfire/orca-pi `packages/pi-rpc/src/connection.ts`, MIT; see
// `pi-rpc-connection-state.ts` for the split contract).
//
// Orca-side adaptations in this file: none (thin `request()` wrappers).

import { PiRpcConnectionRequests } from "./pi-rpc-connection-requests";
import type { PiRpcRequestOptions } from "./pi-rpc-connection-state";
import type {
  PiBashResult,
  PiClearQueueData,
  PiCommandInfo,
  PiEntriesData,
  PiForkMessage,
  PiForkResult,
  PiImageAttachment,
  PiMessagesData,
  PiModel,
  PiSessionStats,
  PiSessionSwitchResult,
  PiState,
  PiStreamingBehavior,
  PiTreeData,
} from "./pi-wire-protocol";

export abstract class PiRpcConnectionCommands extends PiRpcConnectionRequests {

  /**
   * Queue a user turn. Resolves on *accept* (`success: true`), not on
   * completion — turn completion is observed through provider events
   * (`agent_settled` for Pi, terminal `agent_end` for OMP; see #25).
   * Throws `rejected` when Pi is already streaming without a
   * `streamingBehavior` (no state changed); throws ambiguous errors on
   * transport failure (re-read state before retrying).
   */
  async prompt(
    message: string,
    opts: { images?: readonly PiImageAttachment[]; streamingBehavior?: PiStreamingBehavior } & PiRpcRequestOptions = {},
  ): Promise<void> {
    const { images, streamingBehavior, timeoutMs } = opts;
    await this.request(
      {
        type: "prompt",
        message,
        ...(images !== undefined ? { images: [...images] } : {}),
        ...(streamingBehavior !== undefined ? { streamingBehavior } : {}),
      },
      timeoutMs !== undefined ? { timeoutMs } : {},
    );
  }


  /** Queue steering input (delivered before the next LLM call). */
  async steer(message: string, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "steer", message }, opts);
  }


  /** Queue follow-up input (delivered after settle). */
  async followUp(message: string, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "follow_up", message }, opts);
  }


  /** Drain both queues; resolves with the drained contents. */
  async clearQueue(opts: PiRpcRequestOptions = {}): Promise<PiClearQueueData> {
    return this.request<PiClearQueueData>({ type: "clear_queue" }, opts);
  }


  /**
   * Abort the streaming turn. The abort response may arrive *after* the
   * provider's settle event (proven in `abort-queue.jsonl`), so callers
   * that need both must subscribe to provider events *before* sending
   * abort. Settlement predicates are provider-specific (#25), never
   * transport-owned. Esc-pattern: `clearQueue()` then `abort()`.
   */
  async abort(opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "abort" }, opts);
  }


  async abortBash(opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "abort_bash" }, opts);
  }


  async abortRetry(opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "abort_retry" }, opts);
  }


  /** Direct out-of-band execution (streams `bash_execution_update` by id). */
  async bash(command: string, opts: PiRpcRequestOptions = {}): Promise<PiBashResult> {
    return this.request<PiBashResult>({ type: "bash", command }, opts);
  }


  async getState(opts: PiRpcRequestOptions = {}): Promise<PiState> {
    return this.request<PiState>({ type: "get_state" }, opts);
  }


  /**
   * Journal entries + current leaf. `since` is a durable cursor returning
   * strictly-after entries; unknown cursors reject (`Entry not found`).
   */
  async getEntries(since?: string, opts: PiRpcRequestOptions = {}): Promise<PiEntriesData> {
    return this.request<PiEntriesData>(
      since === undefined ? { type: "get_entries" } : { type: "get_entries", since },
      opts,
    );
  }


  async getTree(opts: PiRpcRequestOptions = {}): Promise<PiTreeData> {
    return this.request<PiTreeData>({ type: "get_tree" }, opts);
  }


  /** Active-branch flattened view (excludes pre-compaction/abandoned). */
  async getMessages(opts: PiRpcRequestOptions = {}): Promise<PiMessagesData> {
    return this.request<PiMessagesData>({ type: "get_messages" }, opts);
  }


  async getForkMessages(opts: PiRpcRequestOptions = {}): Promise<{ messages: PiForkMessage[] }> {
    return this.request<{ messages: PiForkMessage[] }>({ type: "get_fork_messages" }, opts);
  }


  /**
   * Last assistant text. Handles both shapes: `{"text": …}` and `{}` (empty
   * when no assistant response yet) → returns `null` for the latter.
   */
  async getLastAssistantText(opts: PiRpcRequestOptions = {}): Promise<string | null> {
    const data = await this.request<{ text?: unknown }>({ type: "get_last_assistant_text" }, opts);
    return typeof data?.text === "string" ? data.text : null;
  }


  async getSessionStats(opts: PiRpcRequestOptions = {}): Promise<PiSessionStats> {
    return this.request<PiSessionStats>({ type: "get_session_stats" }, opts);
  }


  async getCommands(opts: PiRpcRequestOptions = {}): Promise<{ commands: PiCommandInfo[] }> {
    return this.request<{ commands: PiCommandInfo[] }>({ type: "get_commands" }, opts);
  }


  async getAvailableModels(opts: PiRpcRequestOptions = {}): Promise<{ models: PiModel[] }> {
    return this.request<{ models: PiModel[] }>({ type: "get_available_models" }, opts);
  }


  /** Invalid `provider/modelId` rejects (`Model not found`); no mutation. */
  async setModel(provider: string, modelId: string, opts: PiRpcRequestOptions = {}): Promise<PiModel> {
    return this.request<PiModel>({ type: "set_model", provider, modelId }, opts);
  }


  /** Shape per docs (`{model,thinkingLevel,isScoped} | null`); single-model hosts return null. */
  async cycleModel(opts: PiRpcRequestOptions = {}): Promise<unknown> {
    return this.request<unknown>({ type: "cycle_model" }, opts);
  }


  async getAvailableThinkingLevels(opts: PiRpcRequestOptions = {}): Promise<{ levels: string[] }> {
    return this.request<{ levels: string[] }>({ type: "get_available_thinking_levels" }, opts);
  }


  /**
   * Pi is lenient: bogus levels succeed and fall back (no error). Callers
   * must validate via `getAvailableThinkingLevels()` first. Emits
   * `thinking_level_changed`.
   */
  async setThinkingLevel(level: string, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "set_thinking_level", level }, opts);
  }


  /** Emits `thinking_level_changed`; resolves with `{level}`. */
  async cycleThinkingLevel(opts: PiRpcRequestOptions = {}): Promise<{ level: string }> {
    return this.request<{ level: string }>({ type: "cycle_thinking_level" }, opts);
  }


  async setSteeringMode(mode: string, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "set_steering_mode", mode }, opts);
  }


  async setFollowUpMode(mode: string, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "set_follow_up_mode", mode }, opts);
  }


  /** Note: mutates global `settings.json` — use an isolated `PI_CODING_AGENT_DIR` in tests. */
  async setAutoCompaction(enabled: boolean, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "set_auto_compaction", enabled }, opts);
  }


  async setAutoRetry(enabled: boolean, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "set_auto_retry", enabled }, opts);
  }


  /** Rejects fail-closed on tiny sessions (`Nothing to compact`). */
  async compact(opts: PiRpcRequestOptions = {}): Promise<unknown> {
    return this.request<unknown>({ type: "compact" }, opts);
  }


  /**
   * Resume at `sessionPath`. WARNING: a missing path *succeeds* as a new
   * empty session (re-points `sessionFile` with a fresh bootstrap) — confirm
   * with the user before switching to an unverified path.
   */
  async switchSession(sessionPath: string, opts: PiRpcRequestOptions = {}): Promise<PiSessionSwitchResult> {
    return this.request<PiSessionSwitchResult>({ type: "switch_session", sessionPath }, opts);
  }


  /**
   * Fork at `entryId`: abandons the current branch and starts a new session
   * whose bootstrap parents onto the old chain (old messages disappear from
   * `get_entries`/`get_tree`). Confirm destructive use in UX.
   */
  async fork(entryId: string, opts: PiRpcRequestOptions = {}): Promise<PiForkResult> {
    return this.request<PiForkResult>({ type: "fork", entryId }, opts);
  }


  /** Fails closed until the session has been saved (needs an assistant response). */
  async clone(opts: PiRpcRequestOptions = {}): Promise<unknown> {
    return this.request<unknown>({ type: "clone" }, opts);
  }


  async newSession(opts: PiRpcRequestOptions = {}): Promise<PiSessionSwitchResult> {
    return this.request<PiSessionSwitchResult>({ type: "new_session" }, opts);
  }


  /** Emits `session_info_changed`. */
  async setSessionName(name: string, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "set_session_name", name }, opts);
  }


  /** Fails closed when empty (`Nothing to export yet`). */
  async exportHtml(outputPath: string, opts: PiRpcRequestOptions = {}): Promise<unknown> {
    return this.request<unknown>({ type: "export_html", outputPath }, opts);
  }
}
