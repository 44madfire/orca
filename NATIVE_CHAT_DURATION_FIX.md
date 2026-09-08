# Fix completed native-chat turn durations

## Requested outcome

A completed turn must display its actual start-to-completion duration. Opening, restoring, reconnecting, or revisiting the chat hours later must not add idle time to “Worked for”. This child worktree was requested to prepare the fix; no implementation has been made here yet.

## Confirmed incident

On September 8, 2026, the user saw **Worked for 15h 52m 58s** above the response to their “Continue” message. The response was already completed the previous evening.

Actual Codex session events (UTC):

| Turn | task_started | task_complete | Elapsed |
| --- | --- | --- | --- |
| Initial implementation | 2026-09-08T00:48:20.331Z | 2026-09-08T00:57:15.869Z | 8m 55.538s |
| Continuation shown in screenshot | 2026-09-08T01:29:50.323Z | 2026-09-08T01:32:57.839Z | 3m 7.516s |

The continuation ran September 7, **6:29:50–6:32:57 PM America/Los_Angeles**. Summed recorded turn intervals were 12m 3.054s; that is elapsed time inside the two task intervals, not a measured CPU/active-thinking metric.

Adding the displayed 15h 52m 58s to the continuation start lands at **2026-09-08T17:22:48.323Z**, approximately 10:22 AM Pacific the next morning. This strongly indicates that overnight idle time was counted up to the later viewing/status-settlement time.

Local evidence (not for public PR artifacts):

- Session log: `/Users/brennanbenson/.codex/sessions/2026/09/07/rollout-2026-09-07T17-45-11-01a07e79-ddfe-74e3-9f9b-8a9e2bc9baed.jsonl`
- Initial turn ID: `01a07e7c-c12f-7351-8d9b-d9b3748f42a2`
- Continuation turn ID: `01a07ea2-bf94-7b13-889f-83a5108efa90`
- Original user screenshot: `/var/folders/1y/_t14pyzd3qqdml33sfq8b34w0000gn/T/orca-paste-1788888211212-2d07f56b-17fc-4ee2-b0da-4b9473ef5204.png`

## Initial code findings and uncertainty

Inspected in parent `isonade`; this child starts from the repo default `origin/main`, so verify current implementations here before editing.

- `src/renderer/src/components/native-chat/use-native-chat-turn-status.ts`: keeps timing in React state and calls `reduceNativeChatTurnTiming` with `now: Date.now()` inside a layout effect.
- `src/shared/native-chat-turn-status.ts`: reducer settles a non-working turn with `Math.floor((now - startedAt) / 1000)`, taking its start from cached timing or `workingStartedAt`. It has no explicit completion timestamp in that inspected contract.
- `src/renderer/src/components/native-chat/NativeChatResolvedView.tsx`: passes `hookWorkingEpoch` into the message list as `workingStartedAt`.
- `src/renderer/src/components/native-chat/NativeChatStructuredSession.tsx`: inspected version passes `workingStartedAt={null}`. Trace the actual structured-session path as well; do not assume the legacy hook path explains every affected surface.
- `NativeChatMessageList.tsx` and `NativeChatWorkingStatus.tsx` consume/format the result.

**Confirmed:** the displayed duration is false, the session has authoritative completion events, and the inspected reducer can settle using render-time “now” instead of the actual completion time.

**Not yet proven:** precisely which status/hydration/remount transition produced this screenshot, and whether the original running state stayed stale or was reconstructed later. The earlier chat explanation was a likely mechanism, not a completed end-to-end root-cause investigation.

## Implementation direction

1. Trace ownership and delivery of turn start/completion timestamps from the execution host/provider through transcript/status hydration and the renderer. Reuse existing lifecycle data rather than adding another independent timer.
2. Completed durations should derive from authoritative timestamps or a durably captured completion duration. A local clock is appropriate only while a turn is actually running.
3. Missing completion evidence must not become a fabricated duration measured to the current time. Choose truthful fallback behavior consistent with the product.
4. Preserve turn identity across optimistic user-message replacement and resume/reconnect. A later turn must not inherit an earlier start.
5. Cover native and structured chat, shared desktop/mobile timing logic, SSH execution hosts, and folder workspaces. Do not assume disconnection means completion. Read `docs/reference/ssh-execution-boundary.md` and `docs/reference/remote-wire-compatibility.md` before altering remote reporting or exchanged data.
6. Keep this focused on timing. Parent skill-pill changes were uncommitted and are not needed for this fix; do not move or rewrite them.

## Validation expectations

- Deterministic regression: start at 01:29:50.323Z, finish at 01:32:57.839Z, reopen next morning at 17:22:48.323Z; display about 3m 7s (with the existing floor formatter), never 15h 52m 58s.
- Complete while visible, then remount/reload/reconnect: completed duration stays fixed.
- Hydrate an already-completed historical turn with an empty renderer timing cache.
- Start another turn and replace an optimistic user echo without borrowing/resetting the wrong turn's timing.
- Missing completion metadata, aborted/interrupted turns, and temporary loss of host contact have truthful behavior.
- Check current tests in `src/shared/native-chat-turn-status.test.ts`, `src/renderer/src/components/native-chat/NativeChatMessageList.test.tsx`, and `native-chat-working-status-shared-clock.test.tsx`; add meaningful regressions at the owning layer.
- Run relevant typechecks and lint, and validate the rendered elapsed-time behavior through the Electron skill with background launch and CDP screenshots.

## Review findings — September 8, 2026

**Functional correctness: confirmed defect.** Re-read the four named lifecycle events from the incident JSONL. Executed the current shared reducer directly with an empty cache, the continuation start, `isWorking: false`, and the next-morning viewing time. Its formatter returns exactly `15h 52m 58s`; the provider interval formats as `3m 7s`. This proves the defective calculation and its ability to reproduce the reported value, not the exact UI transition that originally triggered it.

**Architectural fit: the direction above is right, but a renderer-only completion timestamp patch is insufficient.** The execution owner must retain per-turn timing and deliver it in snapshots as well as live updates. The UI should project those facts instead of manufacturing completed durations when working status changes.

Concrete current gaps:

- `src/shared/native-chat-turn-status.ts:155` settles against caller-supplied `now`; the desktop hook supplies `Date.now()` and keeps the result only in React state.
- `src/main/native-chat/transcript-turn-lifecycle.ts:36` already decodes provider start/end timestamps. Reuse it. However, `transcript-tail-reader.ts:206` retains only the latest marker, and `transcript-watch-engine.ts` overwrites the batch's marker with the latest one. A latest-status field cannot reconstruct all historical turn intervals.
- `src/main/codex/codex-structured-journal-translation-turns.ts:8` publishes a running lifecycle row, but `codex-structured-journal-settlement.ts:130` tombstones it. The reduced snapshot therefore lacks the completed start/end pair. A raw journal event timestamp alone does not solve this after reduction.
- `src/shared/structured-agent-session-projection.ts:107` excludes lifecycle items from chat messages; `NativeChatStructuredSession.tsx:198` supplies no start timestamp. Project timing alongside messages rather than inferring it from visible prose.
- The reducer's optimistic re-key parameter is used by mobile but not the desktop timing hook. More fundamentally, disappearing message IDs alone do not prove that two entries represent the same execution turn.

### Recommended implementation boundary

1. Extend the existing host-owned lifecycle projection to retain optional start/end timestamps per execution turn, scoped to its session/thread/provider identity. Preserve the start when terminal evidence arrives; make replay and duplicate terminal events idempotent. Use provider event timestamps when available. For live providers without timestamps, capture time once at the execution host's lifecycle ingress, before queues/retries, and retain that provenance. Never stamp recovered completion with recovery time.
2. For transcript-backed sessions, derive intervals from provider boundary records in the same bounded reader/watch pipeline. Preserve interval metadata for loaded historical turns and merge it during pagination. Do not scan whole sessions on every render, and do not replace the existing latest lifecycle status contract with a different meaning.
3. For structured sessions, retain completed timing in the existing journal/snapshot system while preserving cancellation and settlement behavior. Preserve both endpoints explicitly; do not assume the remaining render item's `observedAt` contains both. Publish timing atomically with terminal settlement. Audit crash recovery, rewind, compaction and pruning so they retain, invalidate or remove the matching turn's timing consistently.
4. Deliver optional timing metadata through existing snapshot/delta contracts and project it through shared desktop/mobile logic. Associate optimistic submissions with their acknowledged provider turn using existing submission identity. A session-wide working epoch must not become the start of an unrelated latest user message.
5. Completed display is `floor((endedAt - startedAt) / 1000)` for a valid, evidenced interval. Only the running display reads the current clock. Keep both completed endpoints in the same clock domain; never subtract a client observation timestamp from a remote host timestamp. Missing, malformed or reversed endpoints yield no numeric duration.
6. Keep the current collapsible status row and formatter. Show `Worked for 3m 7s` when known; use a nonnumeric details label when duration is unknown. Preserve interrupted/error wording rather than presenting every terminal state as successful completion. Loss of host contact is `unverifiable`, not completion evidence.
7. Keep additions optional for older hosts and clients. A newer client with no metadata omits completed duration. Retaining lifecycle rows or changing existing host-published status content can affect older clients even without a schema change: preserve the old projection or capability-gate the changed behavior.

### Reference mechanism assessment, without attribution

Inspected mechanisms include persisted server-owned turn endpoints, completed intervals derived from transcript bounds, and a duration stamped once when a client session settles and then persisted. These are not equivalent. Transcript bounds can omit work after the last visible item; client settlement time can include delayed delivery. One server-owned implementation timestamps daemon events at database insertion, which can also distort execution duration under delayed or batched delivery. The recommendation adopts durable lifecycle ownership and static completed rendering, but deliberately requires actual lifecycle evidence for every historical turn instead of those approximations. It also avoids copying unrelated UI layout and styling.

**Validation performed:** source inspection, original session boundary verification, and direct execution of the current pure reducer with the incident timestamps. No production code changed. No full test suite or rendered Electron/mobile QA was run. The exact incident's hydration/status sequence remains unverified. Implementation acceptance still requires the regression scenarios above, plus delayed/batched delivery, duplicate terminal events, pagination, rewind and mixed-version coverage at the affected contracts.

## Workspace protection

For Electron app UI validation, always use `$electron`.
Never use Orca computer-use, `orca computer`, accessibility automation, or OS-level mouse/keyboard automation for Electron validation; these disrupt the user's active workspace.
If `$electron` is unavailable, stop and ask instead of falling back to desktop-control tooling.
Always run tests and agent-launched apps in the background with `ORCA_BACKGROUND_LAUNCH=1`. Never reveal/focus test windows. Use CDP screenshots of hidden renderers.

When `$orca-mobile-emulator-qa` applies, use `orca emulator` for all mobile UI interaction.
Computer Use is permitted only for the screenshot capture required by the skill. Never use it to click, type, press keys, scroll, drag, change focus, or otherwise interact with the UI.
Include these restrictions verbatim in every delegated or orchestrated agent prompt, and stop a worker immediately if it violates them.
If `orca emulator` cannot exercise the flow, report mobile QA as blocked instead of substituting another interaction method.
