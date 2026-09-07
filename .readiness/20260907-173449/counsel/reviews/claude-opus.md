# Counsel seat: claude-opus (findings-severity)

Scope: spot-check of `BUILD-SKILL-001` only. No new-bug scan; no production files edited.

| id | validity | user_impact | severity | reason |
|---|---|---|---|---|
| BUILD-SKILL-001 | valid | none | P2 | Reproduced: `pnpm run verify:bundled-skill-guides` exits 1 ("Generated bundled skill guides are stale: src/cli/bundled-skill-guides.ts"), and the verifier is wired into `pnpm lint` (package.json:16), so a required gate fails. But `src/cli/bundled-skill-guides.ts` is unmodified at HEAD and the only source drift is whitespace-only markdown table re-padding in 4 guides, so shipped guide bytes are semantically identical and no end user or agent sees a behavior change; one-command fix (`pnpm run generate:bundled-skill-guides`) or reverting the incidental formatting. |

## Evidence

- `pnpm run verify:bundled-skill-guides` → exit 1, message instructs `node config/scripts/generate-bundled-skill-guides.mjs --write`.
- `git status --porcelain src/cli/bundled-skill-guides.ts` → empty; the bundle still holds the HEAD table (`| Action gate | Reference |`), confirming staleness is caused solely by the uncommitted guide edits, not a pre-existing gap.
- `git diff -- skill-guides/` → 45 insertions / 45 deletions across `orca-cli.md`, `orca-emulator.md`, `orca-emulator-android.md`, `orca-per-workspace-env.md`; every hunk is table-column padding, plus one rewrap of a hard-wrapped `` `--emulator <id>` `` span in `orca-emulator.md` that is also semantically neutral.
- `skill-guides/orca-cli.md:216` is the reformatted "Action gate | Reference" table header row — cosmetic, unrelated to the default-search preference work in this worktree.

## Severity rationale

Not P0: no data loss, security, or install/update/package failure — the package builds and ships coherent guide bytes. Not P1: no user-visible regression and no capability lost on any supported topology; guide content is unchanged in substance. P2 under "tests/observability/maintainability" and "low user impact with a practical workaround" — a real, reproducible required-verifier failure that must be cleaned up before merge but must not revert anything.
