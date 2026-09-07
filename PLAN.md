# Native chat task lists

## Scope
Render TodoWrite and update_plan inputs as inline checklists using existing tool-call
blocks. No journal schema, transport, main-process, plan-document, or mobile UI changes.
The shared module is a pure, opt-in model; existing mobile consumers stay unchanged.

## Design
- Normalize object and JSON-string inputs into task entries with content, optional
  activeForm, and pending/in_progress/completed status. Unknown/missing statuses become
  pending; malformed payloads fall back to the existing generic tool line. Empty lists
  are valid; invalid entries are ignored unless no valid entries remain in a nonempty list.
- Compare successive valid task-list calls throughout the loaded session, across message
  and user-turn boundaries, ignoring intervening ordinary tools and failed list calls.
  Diff each tool family only against its own predecessor (TodoWrite or update_plan),
  including during streaming before a result arrives. Use existing FIFO tool/result pairing to preserve error visibility.
- Match entries by content plus occurrence order, so duplicates are deterministic and
  reorder-only changes are not reported as starts/completions. Renames are removals/additions.
  Report additions, removals, status transitions (including reopened tasks), and activeForm
  label edits on content-matched entries only. Content renames remain removals/additions.
- First call displays a full read-only checklist. Later calls lead with changed entries,
  keep the full list behind a disclosure, and show concise unchanged feedback when needed.
  Every call includes completed/total progress; optional explanation remains readable.
- Use Circle, CircleDot, and CircleCheck status glyphs with accessible translated status
  text, existing foreground/muted tokens, and activeForm only for in-progress labels.
  Preserve the existing parent tool-run and turn disclosure behavior.
- Derive predecessor context in one transcript pass, passing stable previous call objects
  to message rows rather than introducing a session store or render-time state updates.
  Recompute from loaded history so pagination, rerenders, and session switches stay correct.

## Exact files
- Add src/shared/native-chat-task-list.ts: normalization and deterministic diff model.
- Add src/shared/native-chat-task-list.test.ts: normalizer and diff cases.
- Add src/renderer/src/components/native-chat/native-chat-task-list-history.ts:
  message predecessors and tool-row models using existing pairing.
- Add src/renderer/src/components/native-chat/native-chat-task-list-history.test.ts:
  cross-message/turn, failed-call, independent tool families, and independent-history cases.
  Prepending history must change the formerly-first row predecessor prop referentially,
  making memoized rows switch from the full list to a diff.
- Add src/renderer/src/components/native-chat/NativeChatTaskList.tsx: checklist/disclosure.
- Add src/renderer/src/components/native-chat/NativeChatTaskList.test.tsx: rendering and
  disclosure, progress, accessibility, activeForm, and unchanged updates.
- Modify src/renderer/src/components/native-chat/NativeChatMessageList.tsx and
  NativeChatMessageRow.tsx to thread prior task-list call context. Add pagination/session
  switch integration coverage in NativeChatMessageList.test.tsx.
- Modify src/renderer/src/components/native-chat/NativeChatToolRun.tsx to replace valid
  list tool lines and fold successful associated results while preserving failures.
- Modify src/renderer/src/components/native-chat/NativeChatToolRun.test.tsx to verify
  integration, generic malformed fallback, and failure visibility.
- Modify src/shared/native-chat-tool-icon.ts and its test to classify update_plan as todoList.
- Keep all user-facing copy renderer-side with translate; shared model contains no UI copy.
- Modify src/renderer/src/i18n/locales/en.json for every new visible/accessibility string.

## Verification
Run targeted shared/model/component tests plus existing message-list and tool-run suites
with ORCA_BACKGROUND_LAUNCH=1. Format only changed files and run oxlint on those files.
Do not run pnpm tc or repository-wide formatting. If rendered app validation is available,
use the electron skill, background launch, and hidden-renderer CDP screenshots only.
Commit only lane files, push, open a focused PR, verify clean status and no unpushed commits.
Preserve the supplied brief unchanged under .tmp/task-list-qa/TASK-BRIEF.md with
ignored validation evidence when cleaning the worktree for delivery.

## Risks
- No task IDs exist: duplicate matching is occurrence-based; renames cannot prove identity.
- Earlier unloaded history is unavailable: the first loaded list displays in full until
  pagination supplies a predecessor.
- Existing tool pairing is ordinal; reuse it rather than inventing a second pairing rule.
- Parent activity disclosure still controls visibility; a pinned or always-visible list
  would be a separate product change.
