# Readiness loop 1 findings packet

- Span: `374c676f6df0de88a95a79bf6fe22269f2494c8e` plus uncommitted and untracked changes
- Original PR: none; active uncommitted worktree `default-search-on`

## BUILD-SKILL-001

- Claimed severity: P2
- Original PR: none; active uncommitted worktree `default-search-on`
- Target: `skill-guides/orca-cli.md:216`
- Claim: Four source skill guides in this worktree changed without regenerating `src/cli/bundled-skill-guides.ts`. `pnpm run verify:bundled-skill-guides` exits 1 and instructs regeneration, so a required repository verifier fails and packaged CLI guide bytes remain stale relative to their sources. Regenerating the bundle or reverting the incidental formatting is sufficient.
