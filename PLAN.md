# Notice rows plan

Reviewed and approved with amendments through the coordinator's blocking ask before implementation.

## Changes

1. Classify only `thread/compacted` as substantive and emit `status` with readable
   `Context compacted` text plus optional `presentation: 'compaction'`. Keep the
   duplicate contextCompaction item suppressed. Render a centered divider using
   border and muted-foreground tokens.
2. Keep warnings on their existing error-surface path and retain their generic-row
   cap exemption. Add optional tone metadata: warning/guardianWarning/configWarning
   use warning, deprecationNotice uses notice, actual error-surface failures use error.
   Read summary/details in configuration and deprecation notices and retain raw detail.
3. Add a plan-only branch above the untouched reasoning branch. Keep the full existing
   reasoning branch and streaming fallback textually unchanged. Mark plan documents
   and their streaming snapshots with optional `presentation: 'plan-document'`.
   Render Card primitives with document markdown at body size and existing link handling.
4. Translate imageView and imageGeneration into existing assistant message bodies with
   operation text and existing image-ref blocks. Always populate path or alt so old
   desktop/mobile render meaningful chips. Reuse the existing lightbox and image-data
   validator; retain execution-host paths without performing filesystem operations.

## Exact files

- src/shared/agent-session-journal-types.ts
- src/shared/agent-session-journal-schemas.ts
- src/shared/agent-session-journal-schemas.test.ts
- src/shared/native-chat-types.ts
- src/shared/structured-agent-session-projection.ts
- src/shared/structured-agent-session-projection.test.ts
- src/main/native-chat/agent-session-wire/provider-frame-disposition.ts
- src/main/native-chat/agent-session-wire/provider-frame-disposition.test.ts
- src/main/native-chat/agent-session-wire/unhandled-provider-frame.ts
- src/main/native-chat/agent-session-wire/unhandled-provider-frame.test.ts
- src/main/codex/codex-structured-item-translation.ts
- src/main/codex/codex-image-item-translation.ts
- src/main/codex/codex-notice-item-translation.test.ts
- src/main/codex/codex-structured-journal-translation-streams.test.ts
- src/renderer/src/components/native-chat/NativeChatNoticeRow.tsx
- src/renderer/src/components/native-chat/NativeChatNoticeRow.test.tsx
- src/renderer/src/components/native-chat/NativeChatMessageRow.tsx
- src/renderer/src/i18n/locales/en.json

## Compatibility and risks

- Rule 1 only: no new item kind or block type. All metadata remains optional and uses
  z.string().optional(), never an enum. Renderers narrow only recognized values;
  unknown strings render untinted text. Existing readers retain the readable fallback.
- The same shared projection feeds mobile; its existing text/image blocks continue to
  work. No desktop filesystem assumptions, workspace-kind checks, or path rewriting.
- Host-authored fallback text follows the existing provider-status pattern: English text
  captured and persisted at journal time, not re-localized per viewer. Renderer-owned
  compaction and plan labels use translate with matching en.json keys. No shared copy
  constants or Electron i18n imports in the host translators.
- Warnings reuse the exact existing var(--warning, #f59e0b) fallback pattern. Notices use
  muted-foreground and errors destructive. No new color token or stylesheet changes.
- Prefer savedPath over inline generation data. Invalid, unavailable, or oversized inline
  results render operation text; never embed a clipped data URL. Keep inline references
  below half the existing payload limit to leave room for operation text and the envelope.
- Token usage, rate limits, checklist updates, and reasoning behavior remain unchanged.

## Verification and delivery

- 181 focused tests passed across 10 suites: disposition, fallback translation, image/plan
  translation, journal pipeline, schemas, projection, notice rows, message list, and lightbox.
- Tests cover each tone and reclassification; warning cap exemptions; compaction deduplication;
  plan streaming/completion; full reasoning-body equality; valid/path/pending/failed/oversized
  image outputs; forward-compatible metadata; and an old-reader schema with the new fields
  omitted whose parsed body still renders the original text.
- After isolating plan streaming from the original fallback, its 36 translator tests passed.
- Changed-file oxlint passed. Only owned files were formatted; no pnpm tc or broad formatting.
- Coordinator owns central typechecking, Electron validation, and before/after PR screenshots.
- Commit only lane files, push, and open an unmerged PR. Prove clean status and no unpushed
  commits before reporting worker_done. Preserve the injected task brief under ignored
  .context/notice-task/TASK-BRIEF.md rather than including it in the PR.
