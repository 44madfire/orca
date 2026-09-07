| id | validity | user_impact | severity | reason |
| --- | --- | --- | --- | --- |
| BUILD-SKILL-001 | valid | none | P2 | The verifier exits 1 with `src/cli/bundled-skill-guides.ts` stale. The guide diffs only realign Markdown tables and rewrap unchanged text, so the packaged bytes are semantically identical; the required lint gate still fails until regeneration or reversion. |

Evidence: the verifier byte-compares regenerated content; `package.json:16` includes it in `pnpm lint`.
