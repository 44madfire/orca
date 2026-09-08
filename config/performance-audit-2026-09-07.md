# Desktop performance audit — September 7, 2026

Mobile app excluded. The desktop checklist scan and the confirmed-finding fixes
are implemented in the current worktree. Validation combines operation-count and
retention tests, integration contracts, type/quality checks, and hidden Electron
rendering checks. Real-network and Windows/Linux runtime measurements are outside
the evidence collected here; this is not a claim that every application path is fast.

## Completed scope: 75 verified fix groups

75 distinct fix groups implemented with passing targeted evidence. The user stopped further expansion and requested one completed PR. The original eleven rows below
remain fixes 1–11 in their original order. New findings are counted once per
independent cause, after regression and operation-count evidence pass.

| Fix | Change                                                                                 | Evidence                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12  | Browser-close focus cleanup uses one closed-page ID set                                | 1,000 pages and 1,000 unrelated focus keys: 2,006,000 page ID reads → under 10,000; preserved page/tab ID collision behavior                                         |
| 13  | Metadata read-path pruning waits until the earliest possible expiry                    | 10,000 hits across 500 entries: 5,010,000 timestamp reads → 10,000; exact TTL cleanup, clear and clock rollback covered                                              |
| 14  | Skill-update convergence indexes observable placements by locked name                  | 1,000 locks × 1,000 placements: 1,000,000 name reads → 1,000; unknown/digest/topology eligibility contracts preserved                                                |
| 15  | Separate nested-repo imports skip unused folder-scope construction                     | Repo-path accessor is never visited in separate mode; existing grouped import and cross-platform contracts pass; original fails the no-access test                   |
| 16  | Workspace terminal close indexes neighbor order and remaining membership               | Closing last of 1,001 tabs: 503,503 order-entry reads → under 6,000; duplicate legacy order and MRU behavior preserved                                               |
| 17  | Task-page selection reuses normalization instead of intersecting twice                 | 1,000 persisted IDs: 512,500 repo-ID reads → under 40,000; preferred, missing and empty selection fallback preserved                                                 |
| 18  | Backfill date expansion checks cardinality before allocating the range                 | 2000–2026 marker: 9,747 rejected date-loop iterations → zero; leap day, inclusive limit and future-clock ranges preserved                                            |
| 19  | VM feature restoration indexes identity once across the loaded runtime list            | 1,000 runtimes: 500,500 feature-ID reads → 1,000; first-wins identity, unmatched references and rollback contracts preserved                                         |
| 20  | VM feature sorts precompute identity strings and share the existing sorter             | 2,000 entries: over 20,000 identity reads → 2,000 per sort; stable ordering and merge overwrite parity against original comparator                                   |
| 21  | Batch deletion reuses normalized path matchers                                         | 1,000 directories: 1,998,000 path reads → 2,000; original fails count test; POSIX, Windows, UNC, WSL, repeated-reference and boundary contracts pass                 |
| 22  | Document title-only refresh preserves unchanged store state                            | 200 identical title refreshes: 200 subscriber notifications → zero; genuine title edits and visit bumps still publish                                                |
| 23  | Browser history normalizes only retained candidates and reuses unchanged rows          | 10,000 unique URLs: 10,200 URL reads → 400; repeated normalized pruning returns the same session; recency, dedupe and repair covered                                 |
| 24  | Document history dedupe indexes workspace/path identity                                | 10,000 legacy entries: 1,009,704 workspace-ID reads → 20,000; newest unique visits, cap and tuple identity preserved                                                 |
| 25  | Project identity succession indexes prior memberships                                  | 1,000 bulk promotions: 1,000,000 prior source-list reads → 1,000; overlap weights, duplicate membership, stable ties and runtime preference transfer preserved       |
| 26  | Browser palette indexes unified workspace tabs                                         | 1,000 browser workspaces: 1,001,000 entity-ID reads → under 6,000; duplicate and host-ownership exclusions covered                                                   |
| 27  | Project catalog construction appends to its owned source list                          | 2,000 sources of one project: 1,999,000 accumulating-array elements copied → under 10,000; source order/dedupe and timestamp contracts pass                          |
| 28  | Terminal binding replay lazily indexes prior workspace tabs                            | 1,000 bindings: 502,500 prior tab-ID reads → under 10,000; ambiguity, removed-leaf and host fences retained                                                          |
| 29  | SSH binding cleanup indexes selected-host leases by PTY                                | 1,000 bindings: normalization once per binding; foreign host and conflicting tab/workspace evidence preserved; retirement integration tests pass                     |
| 30  | Limited tool pairing stops once retained pairs are complete                            | 10,000 trailing tool blocks: zero visited after the retained pair completes; FIFO parity for generated sequences, stray results and unusual limits                   |
| 31  | Tool attribution allocates replacement blocks only on rejection                        | 1,000 valid prose messages: zero discarded block appends; valid message identity and orphan-result removal preserved                                                 |
| 32  | AI-vault root filtering/depth truncation prepare root matchers once                    | 1,000 sessions × 100 roots: 200,000 normalizations → 1,100 per operation; WSL aliases preserved                                                                      |
| 33  | AI-vault query matching reads only needed text                                         | Empty/repo/path queries across 1,000 sessions: 3,000 preview-array reads → zero; plain-text matching retained                                                        |
| 34  | AI-vault ordering parses timestamps once per retained session                          | More than 26,000 parses → 2,000; invalid-date sort parity                                                                                                            |
| 35  | AI-vault project attribution reuses results within host/cwd tuples                     | 1,000 sessions/200 repos: 200,000 root comparisons → 200; host isolation and distinct result objects retained                                                        |
| 36  | Checks-panel cwd attribution selects the best candidate in one pass                    | 300 nested roots: 4,778 normalizations → at most 901; current-path ties and WSL/prior-path matching retained                                                         |
| 37  | Jira table sort precomputes priority/date keys                                         | 2,000 issues: 43,796 priority reads → 4,000; date reads → 2,000; grouping contracts pass                                                                             |
| 38  | Linear/Jira aggregate sorting shares cached updatedAt keys                             | More than 10,000 timestamp reads → 2,000; in-place identity and invalid-date ordering parity; provider integration tests                                             |
| 39  | External automation run sorting parses mapped dates once                               | Hermes/OpenClaw: over 28,000 parses → 2,000 each; invalid-date ID fallback retained                                                                                  |
| 40  | Project table sorting/grouping indexes option and iteration order                      | 1,000 options: 8,653,118 sorting ID reads → 1,000; grouping also 1,000; missing metadata and stable ties retained                                                    |
| 41  | Clone URL prefill stops at the first usable source and lazily indexes fallback lookups | First usable source: 500,500 repo-ID reads → 1; all-missing fallback bounded by source/repo counts; credential stripping and duplicate authority retained            |
| 42  | Work-item mutations clone only changed pages                                           | Missing mutation plus one update across 20 pages: 42 arrays → 2; sparse pages, nulls and duplicate matches preserved                                                 |
| 43  | Pane alias migration stores singleton or ambiguity per tab                             | 2,000 repeated legacy rows: 2,001,000 copied elements → under 10,000; ambiguous aliases withheld; singleton aliases retained                                         |
| 44  | Resource Manager indexes tab labels and accumulated worktree rows                      | 1,000 sessions: 502,500 tab-ID reads → under 5,000; 499,500 accumulated-row scans → zero; binding-only callers skip label maps                                       |
| 45  | Skill bundle failure reporting indexes selected IDs                                    | 1,000 selected skills: 500,500 selection reads → at most 2,000; manifest order and cancelled/failed statuses preserved                                               |
| 46  | Terminal adoption topology validates MRU membership with group sets                    | 1,000 restored tabs: 501,501 tab-order reads → at most 3,000; duplicate, foreign-recent and foreign-active groups rejected                                           |
| 47  | Windows variable expansion lazily indexes case-insensitive keys                        | 1,000 mixed-case PATH substitutions: 1,000 environment enumerations → 1; exact-case precedence, undefined-first fallback, unknowns and non-Windows behavior retained |
| 48  | Worker transcript roster twins use counted text membership                             | 1,000 matching rosters: 499,500 shifted array entries → zero; existing exact-before-positional, missing-twin and newer-host fallback contracts pass                  |
| 49  | Automation retention skips ordering when all final runs fit                            | 100 retained runs: 1,056 ordering timestamp reads → zero; append order and final-only eviction retained                                                              |
| 50  | Git history parser reads eight header fields without splitting commit bodies           | 10,000-line body: 10,012 materialized newline fields → zero; body bytes, incomplete headers, legacy Git decorations and subjects preserved                           |

Fixes 32–40 have original-code negative controls in `/tmp/orca-perf-32-40-negative.log` (fix 38 compares directly against the original algorithm). Fixes 41–50 have negative controls in `/tmp/orca-perf-41-50-negative.log`: all ten suites reject the original implementations through twelve new regression failures, while 53 other tests pass. Fixed sources were restored in a `finally` block before final validation. These are operation/allocation reductions, not claims of measured UI latency improvements.

| Fix | Change                                                                        | Evidence                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 51  | Usage event aggregation indexes location/model breakdowns within each session | 2,000 events across 1,000 locations: 2,005,000 project-key reads → under 30,000; totals and model/location cardinality preserved                                          |
| 52  | Usage rollup merging reuses first-match breakdown indexes within a merge      | Two 1,000-location rollups: 2,002,000 location-key reads → under 10,000; duplicate authority and source immutability preserved                                            |
| 53  | Codex ordinal retention indexes forgotten turns separately                    | 1,000 streamed items with 256 forgotten turns: 256,000 active-flag reads → zero; reactivation continuity and byte/entry eviction covered                                  |
| 54  | Claude usage attribution caches matched and unmatched cwd results per batch   | 1,000 turns/100 worktrees: 100,000 containment checks → at most 200; nested path and unscoped fallback retained                                                           |
| 55  | Usage summaries select highest totals in one pass                             | 2,000 totals: over 10,000 comparisons/reads → 2,000; first ties, negatives and malformed nonfinite fallback match original ordering; shared by Claude, Codex and OpenCode |
| 56  | Workspace-space compaction sums omitted sizes as numbers                      | 10,000 top-level items: 9,953 intermediate Other objects → zero; retained rows and omitted byte totals unchanged                                                          |
| 57  | Codex trust upsert consumes ordered unique scan ranges directly               | 1,000 repeated trust blocks: 1,003,998 start-offset reads → under 5,000; upsert/removal contract suites pass                                                              |
| 58  | Host-balanced listings retire exhausted host buckets                          | 1,000 singleton hosts and one large host: 1,001,000 bucket-entry reads → 2,000; original round-robin selection and row order preserved                                    |

Fixes 51–58: `/tmp/orca-perf-51-58-negative.log` records seven expected failures against original production code; fix 55 compares the original sort directly. Targeted results: `/tmp/orca-perf-51-52.log`, `/tmp/orca-perf-53.log`, `/tmp/orca-perf-54-55.log`, `/tmp/orca-perf-56-57.log`, `/tmp/orca-perf-58.log`. Final static checks passed for the completed scope.

| Fix | Change                                                                   | Evidence                                                                                                                 |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 59  | Pane-key removal probes requested keys                                   | 200 absent removals across 1,000 records: full-record enumeration eliminated; inherited and nonenumerable keys preserved |
| 60  | Document addresses short-circuit the current workspace root              | Current-root matches avoid reading the global worktree catalog; existing address contracts pass                          |
| 61  | Pending chat ask replay uses a FIFO cursor                               | 2,000 calls/results: 1,999,000 shifted slots eliminated; replay order retained                                           |
| 62  | Browser tunnel writer checks capacity before encoding                    | 1,000 rejected 64 KB frames: 65,536,000 copied payload bytes eliminated                                                  |
| 63  | Plugin audit reads materialize only recent lines                         | 10,000 records: full line splitting eliminated for a 200-row window; unusual limits and malformed records retain parity  |
| 64  | Windows command-line budgets count escapes directly                      | 30,000-character argument: 12,000 regex match entries eliminated; UTF-16 quoting parity                                  |
| 65  | Pane equalization caches subtree weights per call                        | 200 nested splits: children enumeration bounded below 500; flex output and unchanged second call preserved               |
| 66  | History windows group sequences lazily                                   | 10,000 items with a 100-item window: fewer than 300 sequence reads; byte limits and whole groups preserved               |
| 67  | Foreground agent selection memoizes ancestry                             | 1,000 mixed agent/helper processes: 499,500 parent reads reduced to at most 1,000                                        |
| 68  | Sidebar delete anchors measure each row once before sorting              | 200 mounted rows: at most 201 geometry measurements; no focus or window activation in test                               |
| 69  | Linear primary-team selection indexes selected IDs and chooses a minimum | 1,000 teams: 500,500 selected-ID reads reduced to 1,000; selected and fallback ordering preserved                        |
| 70  | GitLab diff counts scan line prefixes without splitting                  | 30,000 diff lines: line-array allocation eliminated; exact addition/deletion counts preserved                            |
| 71  | JSONL scanning concatenates only the carried first line                  | 100 chunks with 100,000 lines: copied bytes below 1,000; UTF-8, CRLF, stop offsets and partial tails preserved           |
| 72  | Skill selection indexes discovered IDs and names                         | 1,000 selectors: ID reads below 10,000 instead of quadratic scans; duplicate authority and ambiguity preserved           |
| 73  | OS-opened markdown buffering stops merging at its queue cap              | 10,000 paths: fewer than 100 membership probes; first 32 paths retained in order                                         |
| 74  | File matching skips fuzzy ranking when exact matches fill the window     | 10,000 matching basenames: zero fuzzy-ranking calls; deduplication and remaining-slot behavior preserved                 |
| 75  | Authoritative session group rebasing indexes membership                  | 1,000 recent tabs: fewer than 10 array membership probes; retired IDs pruned and active fallback preserved               |

Fixes 59–69: eleven expected regression failures against original production files (`/tmp/orca-perf-59-69-negative.log`), with 47 other tests passing. Fixes 70–75: six expected failures with 50 other tests passing (`/tmp/orca-perf-70-75-negative.log`). Fixed production sources were restored after each negative-control run. These measure avoided work and allocations, not end-to-end latency.

The first three continuation count tests fail with original production files and pass with the
fixes. `/tmp/orca-perf-12-14-negative.log` records the negative controls;
`/tmp/orca-perf-12-15.log` records 63 passing tests across seven relevant suites.
`/tmp/orca-perf-15-16-negative.log` and `/tmp/orca-perf-17-18-negative.log`
record original-code failures for fixes 15–18. Fixes 19–20 compare directly with
original algorithms. Additional passing selections: terminal close 7 tests;
task selection 19; backfill dates 11; VM feature and rollback 19.
Fixes 21–28 have original-code negative controls in `/tmp/orca-perf-21-negative.log`,
`/tmp/orca-perf-22-24-negative.log` and `/tmp/orca-perf-25-28-negative.log`.
Checks through fix 25 passed (`/tmp/orca-perf-12-25-tc.log` and
`/tmp/orca-perf-12-25-quality.log`); final checks now cover all 50 groups (results below).

## Implemented changes

| Path                             | Removed work                                                                     | Regression evidence                                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Editor Git-status reconciliation | Building the status-path index without an eligible conflict editor               | Ten refreshes × 10,000 entries: 100,000 path reads → zero; original implementation fails the count test                                                                                    |
| Filesystem folder authorization  | Scanning all candidate repos after finding a local match                         | 100 scopes × 1,000 repos: 100,000 path checks → 100, with identical authorized roots                                                                                                       |
| Browser SOCKS route opening      | Recopying accumulated pending input on every fragment                            | 1,024 fragments: zero repeated concatenations, under 3× payload copying; original performs 1,024 concatenations                                                                            |
| Skills and Warp theme sorting    | Repeated locale-option setup inside inline and named comparators                 | One collator per sort, old-order parity including ties, names with accents, path tie-breakers and capped recursive scans; 2,000 discovered skills: over 10,000 optioned comparisons → zero |
| Sidebar lineage drag selection   | Rescanning descendants of selected ancestors                                     | 2,000 nested selected rows: 3,998,000 depth reads → 2,000; generated old-algorithm parity                                                                                                  |
| Editor session owner restoration | Searching all prior restored files for each new file                             | 2,000 files: 6,005,000 path reads → under 40,000; legacy IDs, runtime ownership and duplicates covered                                                                                     |
| Active-file restoration          | Searching all restored files per workspace                                       | 1,000 workspaces: over 500,000 property reads → under 6,000; first-file and missing-ID fallback parity                                                                                     |
| Frontmatter restoration          | Hidden override × workspace migration-map lookups                                | 1,000 × 1,000 case: 1,000,000 reads → 1,000; one sparse override still costs one lookup in a large map                                                                                     |
| Local diagnostic sink            | Retaining serialized records already known to exceed the write cap               | Forced-GC case: 26,224,304 retained bytes → under 5 MiB; flush count/timing and small-record scan timing preserved                                                                         |
| Watcher metadata queue           | Starting queued stats after their subscription closes                            | Zero starts for 32 queued canceled records; an active canceled batch stops after its eight in-flight calls                                                                                 |
| Workspace activation inventory   | Visiting unrelated PTY providers and reading every structured workspace snapshot | With 50 SSH providers, a selected-host request visits one provider instead of 51; local requests visit no SSH providers. Structured inventory uses the existing single-workspace RPC       |

No UI layout, color, shortcut, remote protocol schema, or Git command changes.
Activation now selects its execution host through existing ownership resolution.
The optional scope and workspace metadata additions are desktop IPC fields; remote
providers still receive their existing listing request. No persistent caches added. The browser byte limit, diagnostic
flush policy, watcher concurrency limit, and live-event fallback remain intact.

## Verification

All tests used `ORCA_BACKGROUND_LAUNCH=1`; no visible application windows launched.
Electron used isolated test profiles and the existing Playwright CDP-backed fixture.

- Combined run: **447 tests passed across 52 suites**, including all changed
  subsystems and existing hidden-terminal delivery, snapshot recovery, cursor-read,
  liveness, startup-ordering, session-write and browser-cleanup contracts.
- Existing performance contracts: **74 tests passed across 11 suites**, covering
  SQLite preparation/schema parity, parser behavior, highlighting cache,
  filesystem concurrency, queued disposal, retained memory and store identity.
- Activation-gate and cooperative-yield tests: **31 passed across two suites**.
- Transcript/cancellation checks: **20 passed across four suites**. The SSH
  cancellation test here verifies error identity, not connection timing.
- Resumed coverage pass: **226 passed across 23 suites** for Git and provider
  caches, metadata identity, visibility polling, virtualized lists, scanner
  cancellation, browser cleanup and bounded RPC long polls.
- Traversal/lifecycle pass: **115 passed across 15 suites** for live scan budgets,
  deep/wide directory shapes, model disposal, screencast limits, hidden WebGL
  retention, parked resize and execution-host-scoped terminal listing.
- Named skill-comparator follow-up: **37 passed across five suites**, including
  native and WSL discovery integration. The parity/count test invokes the old
  comparator directly, then proves the new sort removes optioned comparisons.
- Subscription/snapshot follow-up: **17 passed across four suites** for terminal,
  sidebar and source-control subscription budgets and dashboard row-cache reuse.
  Together these resumed runs contain 395 passing tests; some suites overlap the
  earlier runs, so their counts must not be added as distinct coverage.
- Activation follow-up: **117 tests across ten suites**, covering the real
  activation seam, provider admission counts, local startup barrier, selected-host
  errors, folder/SSH/runtime identity, workspace metadata and duplicate-writer gates.
- Hidden Electron: **two tests passed, none skipped**, for interactive typing
  and rich synchronized TUI restore. Typing echo: **19.2 ms median, 43.6 ms worst**,
  16 samples. Restore checks verified withheld renderer output, main-owned snapshot
  source, final frame contents and cursor recovery; its screenshot was inspected.
- Full `pnpm tc` and `pnpm run check:code-quality:changed` passed after the latest
  production changes. `git diff --check` passed.
- `pnpm audit:perf` found no production warnings. Its sole warning is the unchanged
  accumulating reference buffer in `src/shared/relay-frame-buffer.test.ts`. The
  resumed invocation reports 20,800 source files and six rules; this is rule
  coverage, not a manual review of every file.

Negative controls temporarily restored the original implementations and failed
new count/retention tests for status indexing, SOCKS buffering, lineage selection,
owner restoration, diagnostic retention and watcher cancellation. Other new
projection tests compare counts and results directly with the old algorithms.
Original files were restored to their fixed state before combined verification.

Counts prove removed work, not end-to-end latency. Tests ran on macOS. Mocked
remote tests establish routing/cancellation behavior, not real SSH RTT or Windows
and Linux runtime behavior. React testing-library emitted existing act-environment
warnings; its assertions passed.

## Activation fix and preserved boundaries

`gateWorktreeAgentActivation` now passes an explicit provider scope to the existing
`pty:listSessions` IPC. Omission retains the diagnostic all-provider behavior;
`connectionId: null` selects only local, and a string selects only that SSH
provider. Local selection waits for the daemon startup handoff. A missing or
failed selected SSH provider rejects the request, which the gate treats as
uncertainty rather than permission to resume another writer.

The gate uses existing workspace route/owner indexes. Missing and ambiguous
owners cannot authorize a local lookup, and paired hosts retain host-owned
activation rather than consulting the client's providers. A positively known
native repo remains usable before the unrelated runtime catalog hydrates,
including when activation settles after selection moves to another workspace.
Folder workspaces do not require a Git worktree row.

Provider-recorded `worktreeId` now survives desktop listing projection, allowing
opaque SSH PTY IDs to match their workspace without guessing from ID syntax.
Legacy listings, including empty workspace metadata, retain the existing minted-ID
fallback. Agent ownership evidence,
listing admission caps and PTY ownership rebuilding remain intact. The existing
surface census still refuses incomplete ownership answers; it was not removed.

Structured activation uses the already-supported `session.tabs.list` with an
explicit workspace selector, replacing `session.tabs.listAll`. Failed, malformed
or mismatched replies reject; the selected workspace's structured handoff checks
remain unchanged. No new remote opcode, schema or provider operation is required.

The manual comparator pass also found `compareSkills`, used by native and WSL
discovery but invisible to the inline-comparator lint rule. Both callers now use
`sortDiscoveredSkills`. Its collator lives for one sort; empty/singleton results
allocate none, and the original path tie-breaker remains.

## Checklist coverage ledger

This ledger gives every supplied desktop scenario a disposition. Source review
and contract tests are sampled evidence, not an exhaustive review of every file
or proof of rendered latency. "Existing" means no additional defect was
established in the reviewed path; it does not certify the entire category.

| Checklist scenario                   | Reviewed path or evidence                                                                                          | Disposition                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| UI input lag                         | Sidebar lineage expansion count/parity; editor reconciliation; virtualized source-control rows                     | Measured fixes; packaged frame gaps still unmeasured                                  |
| Frozen terminal                      | Hidden WebGL retention, parked resize, restored-snapshot and repaint contracts                                     | Hidden rich-frame switch/restore passed; native-focus scenarios remain excluded       |
| Terminal throughput                  | Existing hidden delivery, cursor-read, snapshot and resize contracts                                               | Live typing echo checked; full flood/throughput profiling not measured                |
| Terminal session listing             | Activation gate → global inspect IPC; scoped runtime census                                                        | Host-scoped activation fix; provider-count and ownership tests pass                   |
| Hidden/background terminals          | Hidden delivery and main-owned snapshot recovery tests; parked WebGL retention                                     | Hidden output suppression and snapshot restore verified in Electron                   |
| Scrollback persistence               | `use-app-session-persistence.ts` explicitly avoids periodic scrollback capture; periodic capture records agent IDs | Existing; lifecycle contracts exercised                                               |
| Append-only files and stream carries | Transcript tail reader/cancellation; SOCKS opening buffer                                                          | Buffer fix measured; incremental transcript contracts pass                            |
| Retained backing allocations         | Growing buffer transfer, terminal output queue retention, local diagnostic sink                                    | Measured fixes plus existing forced-GC contract                                       |
| Persistence writes                   | Session-write field gates and allocation/deferred-write tests; hydration projections                               | Measured hydration fixes; existing persistence gates retained                         |
| Polling                              | Visibility interval/timeout poller, coalesced poll runner, rate-limit polling visibility and retry backoff         | Existing; no new polling change                                                       |
| Cooperative yielding                 | `shared/event-loop-yield.ts`: immediate/MessageChannel scheduling with timer fallback                              | Existing contract passes; pacing timers preserved                                     |
| Subprocess churn                     | Worktree scan sharing, sparse annotations and upstream negative-cache contracts                                    | Existing sampled safeguards; activation provider fanout removed                       |
| Startup latency                      | First-window deferral, ready ordering and asynchronous plugin startup                                              | Existing ordering contracts; end-to-end startup timing not measured                   |
| React render churn                   | App shell/task-page subscription boundaries, virtual lists and store identity contracts                            | Existing sampled safeguards; full React profiling not measured                        |
| React store-map subscription churn   | Sidebar details, terminal-pane and source-control subscription budget suites                                       | Existing subscription-count contracts; packaged background-flood counts not measured  |
| Store subscriber hot path            | Session-write subscriber reference gates and per-worktree projections                                              | Existing allocation/deferred-write contracts                                          |
| Store arrays recreated on refresh    | File Explorer projection churn and store identity tests                                                            | Existing; hydration indexing fixes measured separately                                |
| Collection/path fanout               | Authorization short-circuit, hydration indexes, sidebar traversal, inline and named comparators                    | Measured fixes; named-comparator lint blind spot manually checked                     |
| React effects                        | Read-only App shell and resource-inventory lifecycle review                                                        | No effect edits; repository lifecycle contracts used for read-only review             |
| Large lists/diffs/trees              | Source-control, activity, File Explorer, search, AI-vault and CSV virtualization                                   | Existing; mounted-row contracts pass for selected lists                               |
| Parsers and incremental documents    | Markdown tokenizer nonmatch and highlighting-cache performance contracts                                           | Existing; malformed/nonmatch contracts pass                                           |
| Filesystem watching                  | Parcel event delivery, child lifecycle, event batching and stale projection tests                                  | Canceled queue starts removed; live fallback preserved                                |
| Filesystem traversal/space scans     | Fixed-worker entry traversal and retained-listing budget; capacity/control tests                                   | Existing; deep/wide, failure and iterator-close cases pass                            |
| Queued and abandoned work            | Watcher cancellation, transcript cancellation, bounded RPC long polls                                              | Measured watcher fix; real SSH connect cancellation timing not measured               |
| Editor/Monaco                        | Retained-model lifecycle, diff-model prefix disposal, comment decorator model swap                                 | Existing cleanup contracts; no Monaco behavior change                                 |
| Electron/webview                     | Guest lifecycle, retained browser registry, screencast teardown/backpressure                                       | Existing mocked guest lifecycle contracts; rendered terminal checks passed            |
| High-frequency IPC/snapshots         | Screencast shared budgets/latest-frame pacer; bounded remote workspace snapshot cache and dashboard row cache      | Existing sampled safeguards; no wire changes; clone cost unmeasured                   |
| Resource leaks                       | Browser cleanup, model disposal, canceled subscriptions, retained agent status, hidden WebGL                       | Selected close/failure/retention contracts pass; full native-handle soak not measured |
| Memory growth                        | Diagnostic payload retention; bounded metadata, review, diff and workspace snapshot caches                         | Measured sink fix; existing eviction/identity contracts                               |
| Cache/dedupe                         | Worktree generation/deadline/distro keys, metadata auth-generation invalidation, hosted-review host identity       | Existing cache bounds and stale-settlement tests                                      |
| SQL preparation and contention       | SQLite statement reuse/schema column parity; OpenCode scanner bounds                                               | Existing compile/schema contracts; live lock contention unmeasured                    |
| Diagnostics/telemetry                | Disabled persistence diagnostics skip serialization; capped local file sink                                        | Measured rejected-payload retention fix                                               |
| RPC/WebSocket (desktop/shared)       | Runtime long-poll caps, heartbeat lifecycle and browser stream pacing                                              | Existing selected transport contracts; mobile app excluded                            |
| TypeScript/runtime hot paths         | Hydration/path indexes, named comparator search, full typecheck                                                    | Measured runtime fixes; full typecheck passed                                         |

## Evidence limits and artifacts

Every checklist category has a disposition above. The identified fixes have
count, retention or ordering evidence; selected lifecycle and rendering checks
passed. The unmeasured items are limits of this audit's evidence, not assertions
of defects or promises of universal regression freedom. Native-focus/visible-window
tests were not run on the user's desktop. Real SSH RTT and Windows/Linux execution
were not measured; host boundaries were exercised through contract tests.

Following the user's renewed instruction to continue, repository terminal,
execution-host, ownership and remote-compatibility contracts were used in place
of unavailable companion skills. Background-launch and isolated-profile policies
remained enforced.

Validation checkpoint at fix 50 (superseded by the final 75-fix checks below):

- 442 tests across 58 changed suites passed (`/tmp/orca-perf-50-changed-tests.log`).
- 126 tests across 12 additional contract suites passed (`/tmp/orca-perf-50-contracts.log`): 568 tests across 70 distinct suites in these final selections.
- The final iteration fixture type correction was rechecked in its 12-test suite (`/tmp/orca-perf-50-final-fixture.log`); this is included in the 568, not additional coverage.
- Full `ORCA_BACKGROUND_LAUNCH=1 pnpm tc` passed (`/tmp/orca-perf-50-tc.log`).
- Changed-code quality, type-aware quality and React Doctor passed for all 124 changed code files (`/tmp/orca-perf-50-quality.log`). `git diff --check` passed.
- Hidden Electron typing and rich-frame restore results above were collected during fixes 1–11. The later collection-transform changes were validated through unit and integration contracts; those rendered measurements were not rerun or presented as measurements of later fixes.

Current-session artifacts:

- `/tmp/orca-activation-scope-final-contracts.log`: activation unit/integration results.
- `/tmp/orca-activation-final-typecheck.log` and
  `/tmp/orca-activation-final-quality.log`: final static checks.
- `/tmp/orca-perf-hidden-e2e-results.json`: rendered results and typing samples.
- `/tmp/orca-perf-hidden-e2e-artifacts/`: hidden-renderer screenshot.
- `/tmp/orca-perf-coverage-files.txt` and
  `/tmp/orca-perf-lifecycle-coverage-files.txt`: expanded contract selections.

## Final validation at 75 fixes

- 569 tests across 82 changed suites passed (`/tmp/orca-perf-75-tests.log`).
- 72 additional tests across four unchanged contract suites passed: SSH reattach cardinality, tab-create menu, native chat asks and pane-tree operations (`/tmp/orca-perf-75-contracts.log`). Final selection: 641 tests across 86 distinct suites.
- Full `ORCA_BACKGROUND_LAUNCH=1 pnpm tc` passed (`/tmp/orca-perf-75-tc.log`).
- Changed-code, type-aware and React Doctor quality gates passed across 179 code files (`/tmp/orca-perf-75-quality.log`).
- `git diff --check` passed.
- Negative controls through fix 75 and the earlier rendered evidence retain the limits described above. Final renderer collection changes were checked through automated contracts; no new visible-window run was performed.

The completed scope is packaged as one draft PR. No deployment is included.

Final commit-hook cleanup extracted SOCKS upstream delivery and AI-vault project-key formatting into focused modules without changing behavior. All 41 tests across their four relevant suites passed after extraction (`/tmp/orca-perf-75-extractions.log`); these overlap the earlier coverage and are not added to the total.
