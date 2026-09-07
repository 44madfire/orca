# Counsel review — claude-fable (findings-severity)

Scope: spot-check of BUILD-SKILL-001 only. No new-bug scan performed; no production files edited.

| id | validity | user_impact | severity | reason |
|---|---|---|---|---|
| BUILD-SKILL-001 | valid | none | P2 | Reproduced: `pnpm run verify:bundled-skill-guides` exits 1 with `src/cli/bundled-skill-guides.ts` stale (the only stale artifact). The four `skill-guides/*.md` diffs are pure Prettier table/column re-alignment with no wording or gate changes, so the packaged guide bytes are byte-stale but semantically identical — no user-visible effect on `orca skills get`. It is a real `pnpm lint` gate failure that will block CI, fixed by `pnpm run generate:bundled-skill-guides` or reverting the incidental formatting; build hygiene, not release-blocking. |

## Evidence

- `skill-guides/orca-cli.md:216-221`: table rows re-padded; content identical to HEAD.
- `git diff --stat -- skill-guides/`: 45 insertions / 45 deletions across 4 files, all whitespace-only inside Markdown tables (plus one wrapped bullet in `orca-emulator.md` with identical text).
- `config/scripts/generate-bundled-skill-guides.mjs:363-382` (`verifyArtifacts`): byte-compares regenerated content against `src/cli/bundled-skill-guides.ts` and the `skills/*/SKILL.md` stub projections; only the TS bundle mismatched, consistent with stubs deriving from frontmatter (unchanged) rather than guide bodies.
- `package.json:16`: `verify:bundled-skill-guides` is part of `pnpm lint`, so the failure gates CI.

Disposition recommendation: **demote-P2 / keep as P2** — must be regenerated before merge, but not a revert candidate.
