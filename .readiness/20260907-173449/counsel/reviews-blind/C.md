| id | validity | user_impact | severity | reason |
| --- | --- | --- | --- | --- |
| BUILD-SKILL-001 | valid | none | P2 | The required verifier reproduces the stale-bundle failure. The source drift is cosmetic Markdown formatting, so there is no user-visible regression or lost capability; regeneration is a one-command fix. |

Evidence: `pnpm run verify:bundled-skill-guides` exits 1, `src/cli/bundled-skill-guides.ts` is unchanged, and the four guide diffs preserve wording.
