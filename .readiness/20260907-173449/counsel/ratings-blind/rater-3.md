| report | evidence | regression_catch | false_positive_risk | actionability | best_unique | overreach |
| --- | --- | --- | --- | --- | --- | --- |
| A | 3 | 3 | 5 | 3 | none | none |
| B | 5 | 3 | 5 | 5 | Cites `package.json:16` to show the verifier is wired into `pnpm lint`, making the gate failure concrete and locatable. | none |
| C | 4 | 3 | 5 | 5 | Names the exact command (`pnpm run verify:bundled-skill-guides`), the unchanged bundle file, and the one-command fix. | none |
| D | 1 | 1 | 1 | 1 | none | none |

Notes:
- A, B, and C all reach the same verdict on BUILD-SKILL-001 (valid, no user impact, P2); they differ only in how much reproducible evidence they attach.
- A states the finding correctly but provides no evidence line, so a reader must trust rather than verify; B and C both give a reproduction path.
- B's `package.json:16` citation is the only detail that explains *why* this blocks (required lint gate) rather than merely fails locally.
- D produced no report (provider credits exhausted); all its scores are floor values and it should be excluded from any aggregate rather than treated as a low review.
- No report overreached; none escalated a formatting-only bundle drift beyond P2 or claimed user-visible impact.
