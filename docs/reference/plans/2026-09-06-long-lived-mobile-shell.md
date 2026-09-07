# Long-lived mobile shell implementation tracker

Owner: Codex. Branch: `mobile-rearch`. Commit locally; never push.

## Outcome and completion rule

After one native shell upgrade, ordinary product changes ship with the paired
Desktop's page bundle. Native releases are reserved for device capabilities,
secure transport/key storage, WebView/origin policy, background execution and
package installation/recovery. The paired Desktop is trusted. Keep secrets out
of page payloads and retain hard memory, size, rate and concurrency ceilings.

A checked box means implemented and verified, with evidence below. Unit tests
alone do not complete a platform journey. Keep legacy v2 paths for older cached
pages; no protocol or manifest bump is planned.

## Compatibility scope correction — audit completed

User confirmed hybrid has zero released users. Preserve released native mobile →
new Desktop behavior; hybrid → old Desktop may require a Desktop update. Earlier
entries requiring compatibility with intermediate hybrid shells/pages are
superseded by this decision, not evidence of shipped contracts.

The [simplification audit](./2026-09-06-hybrid-compatibility-simplification-audit.md)
contains concrete removal targets and retained boundaries. Runtime cleanup has
not been performed. First establish the final hybrid baseline through the existing
Update Desktop UI, then remove completed slices’ hybrid fallbacks and their dead
shell branches. Preserve native RPCs, real SSH compatibility, page-state/storage
protections and currently unmigrated domain paths.

## Current checkpoint

Last reconciled: September 6, 2026, current host-settings integration batch.
Implementation is **in progress**, not complete.

Latest committed batch: host-scoped forwarding, native-chat file actions and
session terminal creation (`ed6f610ecc1`); shared Terminal/About settings
(`97c4a050ebe`); Terminal consumer fixture (`f2909d35392`). All code gates and
export pass. Full iOS adversarial run passes, including Terminal preference
persistence and actual session consumers. Android smoke passed. The extra
frozen-shell crash-loop fixture is deferred outside the worktree.

Immediate remaining verification: iOS Terminal settings interactions and normal
page update delivery, then Android final smoke. The elaborate A→B→A crash-loop
drill is deferred under the user’s YAGNI direction; existing rollback stays.
After that, commit this batch. Larger remaining implementation: session and other
domain consumers/feeds, remaining settings screens, native-process-death page
resume, and CSP/bootstrap externalization. Details and proof criteria follow.

- [x] Investigate shell/host/page coupling and re-derive host-method census.
- [x] Pin bridge protocol 2 and installed/cached package admission: `11646f11e0f`.
- [x] First complete generic unary slice: `9910fccc298`.
      Desktop catalog, opaque workspace binding, source-control status/diff,
      page-side presentation, legacy fallback, hard payload and concurrency bounds.
- [x] Directory and binary chunk reads use generic forwarding: `a8bbed52da4`.
- [x] File lists/search/text use Desktop privacy adapters: `31024ff0316`.
- [ ] Complete the generic bridge and migrate remaining domain consumers.
- [x] Generic subscriptions and source-control watch: `a0eee2fc21a`.
- [x] Host-owned resources and native-chat reads: `e14164f974f`.
- [x] Native-chat generic feed: `041e40265b6`.
- [x] Bounded host-scoped page preferences and hosted AsyncStorage adapter: `bfb06bad720`.
- [x] Generic request dispatch guards: `ceeacb15725`.
- [x] Desktop catalog authorization correction: `2b354df1463`.
- [x] Generic native-chat TUI actions: `ca6c17a9cd2`.
- [x] Hosted Chat settings with iOS persistence: `9be7d26db91`.
- [x] Desktop terminal metadata actions: `a8a6560a691`.
- [x] Opaque page resume state: `07df01263c9`.
- [x] Hosted Browser preferences and Settings menu: `dd93e3b0073`.
- [x] Bounded Metro script assets: `86215b5dec8`.
- [x] Full unattended existing adversarial harness on iOS and Android.
- [x] Migrated Chat/Browser settings persistence and WebView-restart recovery on iOS.
- [ ] Chat-specific interaction E2E. Additional frozen-shell crash-loop drill deferred (YAGNI).

Catalog authorization correction committed as `2b354df1463`; corrected iOS rerun passed.
Investigation found that advertised `mobileWeb.files.*` and `mobileWeb.nativeChat.*`
adapters were absent from the static mobile allowlist. Prior platform passes can
include legacy fallbacks and do not prove those generic adapters were exercised.
Authenticated dispatch tests cover this gap. The corrected iOS adversarial harness
passes; chat-specific and frozen-shell OTA journeys remain unverified.

Next: migrate remaining domain operations and mutation fingerprint handling;
wire hosted settings with their consumers and page-owned route restoration;
finish bundle/CSP work and verify two-page replacement/rollback on a frozen shell.
The platform passes cover the existing harness, not these outstanding journeys.

Prior investigation and exact gate tails are currently preserved in
`/tmp/orca-review2/codex-ota-investigation.md` and
`/tmp/orca-review2/codex-ota-report.md`. This tracked file is the ongoing status
source; it must not depend on those temporary files to explain remaining work.

## 1. Establish a reproducible mobile test baseline

- [x] Inventory iOS and Android devices and existing app installations.
      iOS: iPhone 17 Pro, iOS 26.5, `DC47C924-6602-497C-BE01-4C80EB391E20`.
      Android AVDs: `OrcaAttachApi36`, `Pixel_9_Pro_API_36`; initially stopped.
- [x] Run the focused iOS hosted-WebView Files/Preview journey against this
      worktree's built Desktop/page and shell. Full adversarial journey also passed.
- [x] Keep tests and launched apps under `ORCA_BACKGROUND_LAUNCH=1`; use hidden
      Desktop renderers and emulator automation without activating desktop windows.
- [ ] Preserve an installed shell/page baseline for mixed-version journeys.

## 2. Complete unary forwarding and opaque identity handling

- [ ] Extend host-advertised metadata without freezing new domain schemas into
      the shell. Keep catalog queries bounded, not the lifetime method vocabulary.
- [x] Support page-safe host-owned opaque handles alongside existing workspace
      handles; retire authority on document/host/client replacement.
- [ ] Preserve intent fingerprints across opaque ID translation. Validate page
      intent before mapping, recompute host fingerprints afterward, and preserve
      clientOperationId, expectedRuntimeFence and retryUnknown.
- [x] Migrate native-chat reads through host-owned opaque resources, preserving
      future host fields and SSH execution routing.
- [x] Migrate native-chat TUI send/respond/stop/prepare-commit actions;
      retain native image/clipboard/pending-storage authority.
- [x] Migrate native-chat readability and file-action adapters: `ed6f610ecc1`.
- [ ] Migrate session reads and mutations, terminal one-shots and files.
- [ ] Extend remaining source-control, task, review and account consumers.
- [ ] Keep errors useful for reconciliation without exposing transport keys,
      raw credentials or native private paths.
- [ ] Remove projections from the active shell path; retain only compatibility
      adapters required by cached legacy pages.
- [ ] Freeze the legacy domain-operation surface with a deliberate census:
      new domain operations use the generic lane, native additions stay explicit.

Proof: a future host method/field works with the same shell; opaque IDs remain
opaque; stale bindings, retries and cancellations cannot cross workspaces;
folder and SSH workspaces still use their actual execution owner.

## 3. Generic subscriptions and transport lifecycle

- [x] Remove the transport's static method-to-unsubscribe dependency for generic
      streams using host-advertised cleanup or a generic host subscription token.
- [x] Preserve direct/relay setup, ready, unsubscribe and reconnect behavior
      for generic subscriptions; covered by transport lifecycle tests.
- [x] Reuse the existing subscription ledger with bounded pending event bytes
      and event count; enforce aggregate subscription ceilings.
- [x] Forward domain event shapes without APK-owned projections (source-control file watch and native-chat transcript feed).
- [x] Migrate native-chat transcript and source-control file-watch feeds.
- [ ] Migrate remaining session/source-control/account feeds.
- [ ] Preserve terminal binary capability negotiation, acknowledgements,
      backpressure and resync; never silently substitute JSON stream semantics.

Proof: cancellation before ready, synchronous events during subscribe, late
handles, client replacement, overflow and reconnect all retire the right host
work and report a terminal closure to the surviving page.

## 4. Page-owned persistence and routing

- [x] Add bounded JSON preferences scoped by paired host and namespace;
      storage identity excludes page build. Keep credential storage inaccessible.
- [ ] Verify preferences across normal page update delivery. Additional rollback drill deferred.
- [x] Replace hosted AsyncStorage's no-op behavior for page preferences through
      an explicit adapter; do not expose arbitrary native storage keys.
- [x] Add bounded page-owned resume state and navigation intents, with legacy
      fallback and current host/document fences.
- [ ] Persist page-owned resume state across native process death and migrate
      remaining domain route resolution; current page registry covers settings.
- [ ] Keep notification receipt and host selection native; let the page resolve
      domain routes after readiness. Never persist document-scoped opaque handles
      as though they remain valid after restart.

## 5. Move presentation to hosted routes

Follow `docs/STYLEGUIDE.md`, existing tokens/primitives and shared mobile screen
components. Reuse presentation; split native dependencies through adapters.

- [x] Native-chat preferences, including iOS persistence and rendered verification.
- [x] Browser preferences, including saved-value consumer and iOS persistence.
- [x] Terminal settings, including host settings and device preferences: `97c4a050ebe`.
      iOS save/reopen and actual session consumers pass.
- [ ] Voice and notification settings; native permission/model actions remain
      explicit capabilities.
- [x] Shared Settings menu with hosted Chat/Browser entries.
- [ ] About, diagnostics, connection-log and remaining Settings entries.
- [ ] Preserve pairing/onboarding bootstrap and minimal offline recovery when
      no trusted healthy page is available.
- [ ] Deliberately update route ownership, reachability and parity tests.

## 6. Remove avoidable package admission coupling

- [ ] Externalize changing inline bootstrap code behind stable native CSP while
      retaining cached-page compatibility.
- [ ] Keep manifest v1 exact keys, canonical hashes and rollback checks intact.
- [x] Split content-addressed bundles before reaching the 10 MiB single-asset
      ceiling; remove the verifier's single-script assumption.
- [ ] Test corruption, interrupted staging, activation health and rollback.

## Compatibility contract

| Combination                              | Required behavior                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Pre-generic old shell / new page         | Detect missing grants/features; use legacy adapters or show bounded feature unavailability.            |
| Generic shell / future Desktop + page    | New domain methods, fields, events and routes need no APK within device capabilities/ceilings.         |
| New shell / old page                     | Keep v2 framing, legacy handlers and cached `[2,2]` package admission.                                 |
| Old cached page / new Desktop            | Keep legacy RPC methods and published semantics; additive catalog is unused.                           |
| New page / older execution host over SSH | Negotiate host capabilities; no local substitution; loss of contact is `unverifiable`, never `exited`. |

## Verification and evidence

Use iOS for the main loop; run Android as the final platform smoke check. The
existing simulator harnesses are the starting point, not duplicate test apps.

- [x] iOS: unattended pairing/activation, workspace privacy, Tasks, Source
      Control, real terminal-link taps, Review/diff and file-preview isolation.
      Evidence: `ios-chat-stream.log` (details in progress log).
- [x] Android: same unattended adversarial journey plus bridge/privacy/exit-info
      audits. Evidence: `android-chat-stream.log` (details in progress log).
- [ ] iOS: native-chat interactions and migrated settings routes.
- [ ] iOS: reconnect, host switching, page restart, cached-page rollback and
      preference persistence across two desktop-served page builds on one shell.
- [ ] Compatibility: old shell/new page, new shell/old page and cached page/new
      Desktop, plus future method/event fixtures through the frozen shell contract.
- [ ] Android: install/start, package activation, generic unary/subscription,
      keyboard/back, settings persistence and restart/recovery.
- [ ] Record physical-device-only gaps (push, thermal/battery, real background
      restrictions and hardware permissions); do not claim simulator evidence for them.

Per implementation commit:

```text
pnpm tc
pnpm run typecheck:tsc:node
pnpm run typecheck:mobile-web
pnpm -C mobile exec tsc --noEmit -p tsconfig.json
pnpm exec oxlint
pnpm -C mobile lint
pnpm run check:code-quality:changed
pnpm run check:react-doctor:changed
pnpm -C mobile test
pnpm test src/shared/mobile-web src/mobile-web src/main/runtime/rpc
pnpm run build:mobile-web
```

Run mobile tests and simulator Metro separately from the web export. The root
`build:mobile-web-rnw` script runs `pnpm --dir mobile install --frozen-lockfile`,
which replaces dependency directories and can invalidate a live Metro resolver.
A previous overlapping mobile test run also failed React Native resolution while
an isolated rerun passed. Build the terminal
WebView engine if mobile typechecking needs it. Run Kotlin unit tests with the
configured JDK 17/Android SDK; prebuild Android when required. Run native Swift
store tests when native package/CSP behavior changes. Format only changed files
with `pnpm exec oxfmt --write`.

## Progress log

- Initial checkpoint: two commits above pass all required gates; mobile 831
  files / 5,493 tests, root 315 files / 2,686 tests. No platform journey was
  claimed. Remaining phases are open.
- Initial next step was the emulator baseline and generic identity/transport;
  completed progress and remaining work are reconciled in the checklist above.

- iOS baseline first build failed because Pods referenced a stale pnpm React Native
  package directory. Regenerated with `pod install`; native build retry running.
  Evidence: `/tmp/orca-ota-e2e/ios-native-build.log`, `ios-pods.log`,
  `ios-baseline-retry.log`.
- Verified implementation: Desktop advertises `files.readDir` and `files.readChunk`; the page
  owns their presentation using the same generic shell contract. Legacy adapters
  remain for cached pages and unsupported/oversized generic reads.

- File-read migration gates all pass: mobile 831 files / 5,493 tests; root
  316 files / 2,693 tests, all typechecks, lint, changed-code and React Doctor.
  Export: 52 assets / 9,685,882 bytes, build
  `1df386b5e949d67736d00ba2ca456e157d62ef1db0a619e2363dad6804741a13`.
  Exact command tails: `/tmp/orca-ota-e2e/file-gates/`.
- iOS retry reached native compilation but failed at React-RCTFabric
  `RCTFabricSurface.mm`; capturing full compiler diagnostics before proceeding.

- iOS native build now passes after regenerating Pods and replacing stale derived
  compiler caches. The old derived data is preserved at
  `/tmp/orca-ota-e2e/stale-ios-derived-data`; no dependency source patches needed.
  Full successful log: `/tmp/orca-ota-e2e/ios-native-build-clean.log`.
- Running the existing iOS adversarial-content journey (which includes source
  control) on that build, with `--skip-native-build`, in
  `/tmp/orca-ota-e2e/ios-journey`. Pairing runtime started and Metro is loading.
- In progress: file list/search and text reads via Desktop privacy adapters
  `mobileWeb.files.searchPaths` / `mobileWeb.files.read`. They reuse existing
  host methods and remove private workspace/root fields before forwarding.
  Future result fields remain available to the page; native request contract
  stays unchanged. Focused tests pass; full gates running.

- File list/search/text migration passes every required gate: mobile 831 files /
  5,493 tests; root 317 files / 2,699 tests. Page build:
  `8143c37da629651d2e672268423846e8d44fbf33e90637f4436791b4a33e7a53`,
  52 assets / 9,688,231 bytes. Logs: `/tmp/orca-ota-e2e/file-text-gates/`.
- First iOS hosted run paired successfully, then page export's dependency
  reinstall invalidated the live Metro resolver (`InitializeCore` not found).
  Retired that launcher; rerun after all builds, with no concurrent install/export.

- Android native shell unit suite passed; Android debug APK build passed (535
  tasks). The usable AVD is `Pixel_9_Pro_API_36` (`arm64-v8a`); `OrcaAttachApi36`
  has a corrupt registration. Started Pixel headlessly with `-read-only` and
  `-no-snapshot`; smoke run is `/tmp/orca-ota-e2e/android-smoke.log`.
- iOS runtime evidence found standalone Tasks/Accounts toolbar icons lacked the
  labels already present in the embedded toolbar. Added those labels and button
  roles; no layout/style changes. The page then passed the Tasks fixture.
- Harness fixes in progress: match the workspace pathname after native Alert;
  include bounded route/labels in missing-control diagnostics; handle absent
  native screenshot baselines in the adversarial source-control mode and use
  that fixture's workspace instead of depending on our uncommitted files.
- Latest page build (toolbar labels):
  `0d1a80e371e8ddf115c38fb4d784772d006059756c752edae198454e149021e2`.
  iOS run: `/tmp/orca-ota-e2e/ios-file-journey.log`. Do not count a whole
  platform journey as passed until the harness returns its success report.

- iOS `ios-ax-journey` passed onboarding, hybrid activation, native Alert,
  workspace privacy, adversarial Tasks, and host-origin Source Control/Review.
  Fixed AX prefix matching to accept WebView values as well as native labels;
  regression covers both. The run then failed terminal file-link activation:
  OSC link content exists in the buffer, but the native tap did not open it.
  This remains unresolved; no complete iOS success is claimed.
- Android Tasks now reuses the existing accessibility/semantic control activation
  path with label and document context, instead of relying solely on viewport
  coordinate estimates. Smoke rerun: `android-label-smoke.log`.
- Running focused iOS file-preview parity separately (`ios-files-only.log`) to
  distinguish file-read behavior from the terminal-touch failure.

### Validated checkpoint and next blocking test

- **PASS:** iOS focused Files/Preview journey exited 0 with `ok: true`.
  Log: `/tmp/orca-ota-e2e/ios-files-only.log`. Screenshots in
  `/tmp/orca-ota-e2e/ios-files-only/`: `hosted-files-portrait.png` and
  `hosted-file-preview-portrait.png`, with matching native baselines. File-list
  and preview pixel/landmark comparisons pass their existing budgets; hosted
  preview was also visually inspected. Native Alert and isolation probes pass.
- **PARTIAL:** Android rerun passes install/start, pairing, hybrid activation,
  hosted workspace data, privacy, Tasks/error presentation and Session navigation.
  It fails the same terminal OSC file-link activation gate as iOS. Neither
  comprehensive platform journey is green. Android log:
  `/tmp/orca-ota-e2e/android-label-smoke.log`.
- **PASS:** all required typechecks, lint, changed quality/React Doctor, mobile
  tests (831 files / 5,496 passed), root tests (317 files / 2,699 passed) and page
  export. Gate tails: `/tmp/orca-ota-e2e/route-final-gates/`; export log:
  `/tmp/orca-ota-e2e/route-gates/build-page.log`.
- **Next blocking work:** capture actual delivered touch coordinates/events and
  trace retained/live OSC ranges through terminal resize/replay to file-tap RPC
  and tab activation. The existing diagnostic proves buffer content and intended
  point, not which handler ran. Do not replace native taps with scripted handlers
  and claim this gate passed. Per the task brief's stop-at-failing-gate rule,
  further domain/subscription/screen migrations are held at this checkpoint.
- Current testing uses development shells and one page build. Frozen release-shell
  skew, two-page OTA replacement/rollback and physical-device behavior remain
  unverified. No push or deployment was performed.

## Resumed implementation

User requested continuing through completion. Investigation of the terminal gate
now proves native tap delivery, OSC lookup, host path resolution and activation
fencing all succeed; file-tab opening returns `host_error`. The headless fixture
has no renderer, and `files.open` throws `renderer_unavailable` in that topology.
The positive fixture now includes a line target to exercise the supported hosted
preview route and return to the terminal. Renderer-backed file-tab opening remains
a separate Desktop validation case. Traces: `ios-link-trace-stable.log` and
`ios-open-trace.log` under `/tmp/orca-ota-e2e/`.

A failed/malformed `session.tabs.list` no longer revokes native-chat authority;
it reports a retryable host error. Successful snapshots still establish removal.
Next implementation slice: host-advertised generic subscriptions, cleanup
metadata, bounded queues, and page-side source-control invalidation.

### Generic subscription implementation

Implemented `workspace.hostSubscribe` using Desktop catalog mode/cleanup metadata,
opaque workspace binding, and unchanged protocol 2. Source-control invalidation
now consumes Desktop file-watch events in the page, with legacy shell/host fallback.
Direct and relay transports retain arbitrary cleanup routes across early cancellation;
direct reconnect clears old tokens. Generic transport records cap at 128, including
cancelled records awaiting ready. Ledger queues cap at 64 events / 2 MiB; aggregate
admission counts legacy, terminal and generic subscriptions together.

All required gates pass. Mobile: 834 files / 5,515 passed; root: 318 files / 2,700
passed. Additional capacity tests: 3 files / 14 passed. Deliberate dispatch census
228 → 229; reauthorization census includes generic stream delivery and extracted
workspace dispatch. Logs: `/tmp/orca-ota-e2e/generic-stream-gates/`.
Page build: `925397fb68c40b511854af454cce2a2989134aa34a517f10fd494064f36ea895`.
Native-chat/session/account feed migration and platform E2E remain open.

### Host-owned resources and native-chat reads

Generic subscriptions committed as `a0eee2fc21a`. Added a bounded Desktop resource
registry keyed by runtime, authenticated connection, shell-injected page session,
workspace and resource kind. Handles contain no provider IDs or transcript paths;
connection cleanup retires them, and another page session cannot resolve them.
The shell's optional catalog `pageSessionParam` injects native document authority,
feature-negotiated as `workspace.hostPageSession.v1` without a protocol bump.

`mobileWeb.nativeChat.bind/read` reuse authoritative session snapshots and the
existing transcript reader (including SSH routing). The hosted native-chat read
consumer uses those opaque handles and retains future result fields. Revalidation
before and after asynchronous reads refuses replaced bindings. Failed snapshots
remain retryable and do not revoke handles. Old hosts/shells retain the legacy read.
Chat streams, mutations/fingerprints and remaining domain migrations are still open.

Required gates pass: mobile 836 files / 5,522 tests; root 320 files / 2,706 tests.
Logs: `/tmp/orca-ota-e2e/native-chat-read-gates/`. Page build:
`948c8d1f271bf96f45f40ae8bf9e70835790606d8646432c3474e7c721e7bcd7`.

Platform progress: iOS `ios-generic-stream.log` passes native taps/terminal links,
Tasks and Source Control. `ios-generic-stream-diff.log` also confirms adversarial
diff content after waiting for its body. It then exposed a fixture assumption:
Review's Back returns to its source route, and Session need not render literal
`tabs` text. Updated both readiness checks. One manually assisted Back action was
used to inspect this failure; this is not a complete unattended E2E pass. Rerun
with the committed fixture before claiming full iOS coverage; Android remains open.

### Native-chat feed migration

Read/resource slice committed as `e14164f974f`; harness readiness fixes as
`79f54a8b49e`. Native-chat subscriptions now use the same host-owned opaque
resources and generic stream. The host announces a random cleanup token and
reuses the existing transcript watcher. Every event checks the authoritative
provider binding before publishing; changed bindings close once. Setup failures
release registered watchers. Cancellation during page binding opens no watcher,
and cancellation inside ready delivery cannot publish a subsequent snapshot.
Future transcript/event fields stay intact on the active generic path.

All required gates pass: mobile 836 files / 5,525 tests; root 321 files / 2,709
tests. Additional focused cancellation/setup checks pass (mobile 7, root 4).
Logs: `/tmp/orca-ota-e2e/native-chat-stream-gates/`.
Page build: `81e5d5f47e703f4047e8544d5f3812459adf71ed45ec0951a840129797b6e266`.
Next: rerun iOS with the updated fixture, then continue mutations, session/domain
migration and page-owned preferences/routes. No complete platform run claimed yet.

### Full iOS adversarial journey passed

`041e40265b6` commits the chat feed. The unattended run
`/tmp/orca-ota-e2e/ios-chat-stream.log` exited 0 with `ok: true`, using page
`81e5d5f47e703f4047e8544d5f3812459adf71ed45ec0951a840129797b6e266`.
It passes pairing/activation, Alert, workspace privacy, Tasks, both Source Control
entry points, real native terminal-link taps, Review/diff text, Markdown/HTML/SVG/
image preview checks, and network/navigation/executable isolation. This is a
complete pass of that harness, not coverage of native-chat-specific interactions,
OTA replacement/rollback, remaining settings or physical-device behavior.

### Host-scoped page preferences and Android pass

Both unattended adversarial platform runs pass with page `81e5d5f47e703f4047e8544d5f3812459adf71ed45ec0951a840129797b6e266`:
`/tmp/orca-ota-e2e/ios-chat-stream.log` and `/tmp/orca-ota-e2e/android-chat-stream.log`.
Android includes bridge/privacy/exit-info audits. The temporary Android emulator
was stopped afterward. These runs do not cover chat interactions, settings,
frozen-shell OTA swaps/rollback, or physical devices.

Added strict native `pagePreferences` with paired-host scope captured in native
authority, namespace isolation, ordered bounded writes, 64 KiB value and 2 MiB
host limits. Hosted AsyncStorage now uses this grant; inaccessible/corrupt storage
fails explicitly. Credentials remain inaccessible. Preferences survive page build
changes and rollback. Removed the obsolete inert adapter. Settings routes and
legacy native preference migration remain open.

All 11 required gates pass in `/tmp/orca-ota-e2e/page-preferences-gates/`:
838 mobile files / 5,533 passed (before removal of one obsolete inert test),
321 root files / 2,710 passed. Cleanup focused checks: 2 files / 4 passed.
Dispatch census 229 → 230; persisted-state inventory updated deliberately.
Page export: `1b3542d5b0c6f01d99f4775a4f741f2c3e136397a6cb59f2f1f08368557eab26`.

### Generic request dispatch lifetime

Added final synchronous dispatch guards to direct and relay transports; generic
host requests revalidate page and workspace authority after connection waits,
immediately before transmission. Logical connection replacement fences old
physical requests. Catalog lookup and execution share a 15-second native budget;
standalone catalog reads are bounded too. Cancellation prevents an unsent frame;
it does not undo a frame already transmitted. Mutation consumers must preserve
unknown delivery and never automatically retry it. The additive feature
`workspace.hostRequestDispatch.v1` lets future pages require this behavior.

All required gates pass (`/tmp/orca-ota-e2e/dispatch-gates/`, final rechecks included).
Mobile: 840 files / 5,540 passed. Root: 321 files / 2,710 passed.
Reauthorization census deliberately increases host-request sites 2 → 3.
Extracted logical-client types and request authority to retain the 300-line limit.
Page build: `2e64a57e693f312c4113831e84404f87f009bbe5803a9ef19ddc7a8b0d5fffe9`.
No new platform pass claimed for this slice. Native-chat mutations remain open.

### Catalog RPC authorization correction

Dispatch lifetime committed as `ceeacb15725`. The advertised page adapters were
missing from Desktop's static mobile allowlist. A real authenticated-dispatch
test reproduced `forbidden` for `mobileWeb.files.searchPaths` before the fix.
Desktop now authorizes exact catalog membership plus declared cleanup methods;
it does not grant a namespace wildcard. The regression checks every registered
catalog method/cleanup, successful file-read privacy/future-field preservation,
and refusal of unadvertised/deletion operations. Legacy cleanup-map census now
recognizes the host-provided cleanup fallback added in the subscription slice.

All required code/test gates pass after test type fixes; 840 mobile files / 5,540
tests and 321 root files / 2,710 tests. Additional authenticated authorization
suite: 4 files / 17 tests. Logs: `/tmp/orca-ota-e2e/catalog-authorization-gates/`.
Before-fix failure: `/tmp/orca-ota-e2e/catalog-authorization-before.log`.
Export passed with build `2e64a57e693f312c4113831e84404f87f009bbe5803a9ef19ddc7a8b0d5fffe9`.
The corrected iOS adversarial journey passed: `/tmp/orca-ota-e2e/ios-catalog-authorized.log`,
`ok: true`, exit 0. It uses the authorization-fixed Desktop and the exported page
above; it does not test the subsequent chat-mutation slice.

### Native-chat actions — code and export verified

Hosted send/respond/stop/prepare-commit now choose the generic lane only when
both page-session identity and `workspace.hostRequestDispatch.v1` are supported.
Old shells/hosts retain legacy operations. Desktop resolves the opaque transcript
resource before each write and reuses `terminal.send`, including authenticated
mobile ownership, input locks/floor, launch-draft resolution and SSH execution.
Command pacing remains shared; the final Enter carries draft resolution.

Catalog lookup/binding share the caller's remaining budget. Once a mutation is
dispatched, errors or malformed receipts never trigger legacy fallback. Ambiguous
outcomes remain unknown; preparation only reports success after acknowledgement.
A page cancellation cannot undo an already transmitted mutation. Host disconnect
stops paced command writes through the existing RPC signal. Native image,
clipboard and pending-storage actions retain native authority.

Focused host and bridge tests pass, including mixed versions, stale bindings,
authenticated identity, exact stop/command bytes, timeout exhaustion and no retry.
All required gates pass in `/tmp/orca-ota-e2e/chat-mutations-gates/`:
841 mobile files / 5,550 passed; 323 root files / 2,717 passed. Additional catalog
authorization check passes; final deadline-focused rerun is 4 files / 29 tests.
Export: `47338504aaa0cc119190d6ffe03069b54eaa0c6af6663f8fdeaaf6524b134774`.
Chat actions committed as `ca6c17a9cd2`. Android adversarial regression passed
with this export: `/tmp/orca-ota-e2e/android-chat-mutations.log`, exit 0, `ok: true`.
It includes bridge/privacy/exit-info audits. The temporary emulator was stopped.
This harness does not exercise chat composition.
Native-chat simulator interaction coverage remains open.

### Hosted Chat settings — verified

The existing Chat UI preference screen is now shared by native recovery routes
and `/native-chat-settings` in the hosted page. The hosted copy identifies the
paired-host preference scope. The workspace toolbar exposes it only when the
native page-preferences grant exists; unsupported routes disable the switch.
The same preference loader already drives hosted session defaults on focus.
Root shell context readiness remounts the settings screen before reading storage.

All required code/test checks pass: 841 mobile files / 5,552 tests; root 323 files /
2,717 tests. Route ownership was updated deliberately. Export passes with build
`de9aad2671b418d061b58035707436f16172385358817648f6722540fd760fee`.
The full iOS adversarial run, including Chat settings save/reopen, passes with
`ok: true`, exit 0: `/tmp/orca-ota-e2e/ios-chat-settings-themed.log`. Its screenshot
was visually checked; the web switch uses the existing theme thumb token.
Other settings and page-owned route restoration remain open. Gate logs:
`/tmp/orca-ota-e2e/chat-settings-gates/`.

### Parallel implementation checkpoint

User authorized parallel agents. Current uncommitted slices: negotiated opaque
page resume state; hosted Browser preferences and a shared Settings menu;
Desktop terminal metadata actions; content-addressed Metro module chunks.
Each has a distinct owner; full gates/export and simulator work remain serialized
by the primary agent. No platform pass is claimed for these slices yet.

Session audit clarified that hosted structured sessions are not wired today.
Fingerprint translation is a prospective migration requirement. Desktop's
existing structured-create adapter already validates the original intent before
mapping and recomputes the final fingerprint; reuse it. Session snapshot migration
must move browser/chat binding consumers with it: current snapshots populate
shell authority registries as well as presentation.

### Parallel slices — full code gates passed, iOS running

Implemented bounded page-owned resume state with `navigation.pageState.v1`,
legacy fallback and host/document fences. Native cold-resume carries the state
while rebinding workspace handles; explicit notification/deep-link navigation
clears it. Current registry covers Settings/Chat/Browser. State survives WebView
and package replacement within the native session; native process-death storage
and remaining domain routes are still open. Full gates caught and corrected the
init-message builder omitting page state; an actual init serialization test now
covers it.

Browser preference presentation and the Settings menu are shared with native
screens. Hosted link mode inherits the native setting until a paired-host page
value is saved. Load/save failures are visible and session refresh retains prior
state on storage failure. Chat switch readiness now covers both loading and saving.
The session callback-body parity digest was updated deliberately for the preference
refresh rejection handler; hook/callback counts and other digests stay intact.

Desktop terminal metadata actions now bind/revalidate a specific terminal before
clear/rename/display-mode dispatch. Binding precedes stream opening. Old shells
and hosts use legacy operations only before dispatch; no mutation error retries
on another lane. Native input, clipboard/image and binary-stream behavior remains.

The packager splits Metro registrations into five ordered content-addressed
scripts around 2 MiB, allowing indivisible modules up to the existing 10 MiB native
asset ceiling. The manifest remains v1/[2,2]. Unit execution tests cover ordering,
directives, Unicode byte limits and invalid shapes. Native CSP externalization
is still open.

All 11 required gates pass: 845 mobile files / 5,582 tests and 326 root files /
2,737 tests. Logs: `/tmp/orca-ota-e2e/parallel-integration-gates/`.
Export: 56 assets / 9,719,623 bytes; build
`0fa171d14e01d38d09bae36f9734e4027bac2f0b31769e97dd0c8b370b5d5143`.
The iOS full adversarial run now includes both settings persistence and a real
WebContent process restart on Chat settings. Running log:
`/tmp/orca-ota-e2e/ios-parallel-integration.log`; no success claimed yet.

The first integrated iOS run passed Chat persistence and real WebContent-restart
route/value recovery. It then failed because the Browser fixture selected an
option before the animated picker was visible. Added a bounded visibility wait;
page code/export unchanged. Retry: `/tmp/orca-ota-e2e/ios-parallel-integration-retry.log`.
The recovered Chat screenshot was checked, including the native recovery banner.

### Integrated iOS checkpoint — passed and committed

`/tmp/orca-ota-e2e/ios-parallel-integration-retry.log` exited 0 with `ok: true`.
This validates five-script page loading, both hosted settings save/reopen flows,
Chat route/value restoration after a real WebContent process restart, native
Alert, privacy, Tasks, Source Control/Review, terminal-link native taps and all
existing adversarial isolation checks. Browser and recovered Chat screenshots
were visually inspected. The crash recovery banner is expected after deliberate
WebContent termination. Android's prior pass predates these changes; final smoke
and real two-page OTA/rollback remain open.

Commits: terminal actions `a8a6560a691`, page resume `07df01263c9`, hosted Browser/menu
`dd93e3b0073`, Metro chunks `86215b5dec8`. All share the full integration gate and
export evidence above; the final picker-visibility fixture fix additionally
passed targeted lint and the complete iOS retry. Nothing was pushed.

Next implementation: host-scoped generic requests for zero-workspace settings,
Terminal preferences with both readers/writers, and a frozen-shell A→B→A fixture
using authenticated Desktop delivery and native crash-loop rollback. Session
migration must account for legacy browser/native-chat resource aliases; no raw
session snapshot passthrough is planned.

### Next batch in progress

Host-scoped generic forwarding is implemented in the working tree, negotiated as
`workspace.hostScope.v1`. Desktop must explicitly grant host scope before a request
may omit its workspace; workspace methods cannot be downgraded. Host-wide
subscriptions retain the same bounded ledger/cleanup. The page has `client.host`
request/catalog APIs, and auto-restore-fit settings are catalogued as host-wide.
Focused forwarding/scope tests pass (25 mobile tests) and authenticated dispatch,
contract/client tests pass (15 root tests); full gates are pending this batch.

Parallel work in progress: shared Terminal settings and all preference consumers,
remaining native-chat file/readability actions, and `--ota-only` A→B→A delivery
fixture. Native process-death restoration, session migration, remaining settings
and CSP bootstrap externalization remain open. No new platform pass claimed.

### Host-settings integration — current verification

All four typecheck commands and both lint commands passed. Changed-code-quality
passed with zero new findings. Root tests passed: 328 files / 2,758 tests.
The first mobile suite had 848 passing files and two failures: a census still
classified `/terminal-settings` as native-only, and a source-binding assertion
expected the old device-operations constructor signature. Both now reflect the
implemented hosted route; their focused tests pass. React Doctor's two callback
findings were fixed with a typed async-result completion callback, without
suppressions. Full mobile and React Doctor retries are in progress. Logs:
`/tmp/orca-ota-e2e/host-settings-integration-gates/`.

Terminal settings include native fallback, inherited native values until explicit
paired-host overrides, read/write errors, and shared shortcut presentation. Native
auto-restore reads now correctly unwrap `RpcResponse.result`. The route census
change is deliberate because Terminal now has an actual hosted page. No export
or simulator result is claimed for this batch yet.

### YAGNI scope and active parallel assignments

User asked to prioritize necessary implementation over recovery sophistication.
Keep existing native rollback; defer the additional crash-loop drill and optional
resume enhancements while domain migrations remain. No new recovery machinery.

Current assignments:
- Session agent: next complete session/domain operation slice, preserving opaque
  identities and mixed-version behavior without duplicate authority feeds.
- Settings agent: remaining page-owned settings presentation using existing
  native capabilities, selecting a bounded complete screen migration.
- Fixture agent: finish Terminal interaction fixture only; no additional rollback
  work.
- Primary agent: bridge integration, review, code gates, serialized export and
  platform validation, plan maintenance and local commits.

Latest retries passed: mobile 850 files / 5,604 tests and React Doctor exit 0.
The remaining items are not all independently parallelizable; shared bridge
changes, exports and simulator runs are coordinated centrally.

### Session creation and About integration

The parallel session slice is implemented and wired: agent discovery and blank/agent
terminal creation now use Desktop adapters through generic workspace forwarding.
Creation reuses existing runtime idempotency/navigation and does not fall back
after dispatch. Agent discovery reuses execution-host resolution for SSH, folder
and floating workspaces. Existing snapshot/feed authority handling remains; this
does not complete the remaining session migration.

About now shares presentation between native and hosted routes, with actual native
version or interface build respectively. Privacy/Support links reuse existing
external-link capability. No new native capability was introduced.

Integrated typechecks, React Doctor and changed-code quality passed; root tests
passed 330 files / 2,773 tests. Corrected the existing legacy roundtrip fixture to
explicitly advertise no new shell features, preserving its fallback purpose;
focused roundtrip passes. Fixed bridge max-lines through simpler constructor
binding, without suppression. Final mobile suite/lint are running before export.
The Terminal fixture now checks saved scale/autocomplete/custom shortcuts in the
actual session consumers and restores original preferences; no device pass yet.

### Committed integration — iOS passed, Android running

Commits: `ed6f610ecc1`, `97c4a050ebe`, `f2909d35392`. No push.
All required code gates pass: mobile 850 files / 5,606 tests; root 330 files /
2,773 tests. Gate logs are in `/tmp/orca-ota-e2e/host-settings-integration-gates/`
(final mobile and lint retries are `mobile-tests-final.log` and `oxlint-final.log`).
Export passed: 56 assets / 9,776,516 bytes / 2,804,022 gzip, build
`eab7fd8f5eb4a37e593526e90dcc5105552691db072da8a982cd1ed30784a2e3`.

Full iOS run `/tmp/orca-ota-e2e/ios-terminal-session-integration.log` exited 0 with
`ok: true`. It covers Chat/Browser/Terminal settings persistence, Terminal scale
and autocomplete/custom-key session consumers, privacy, Tasks, Source Control/
Review, native terminal links and adversarial isolation. Terminal screenshot was
visually inspected. The native recovery banner follows the existing deliberate
WebContent-restart check. No new crash-loop drill ran.

Android smoke is running in `/tmp/orca-ota-e2e/android-terminal-session-integration.log`;
no pass claimed until completion. About rendering and new session creation are
code-tested but not specifically exercised by the iOS fixture. Remaining session
snapshot/feed/mutation families, Voice and other settings screens remain open.

### Android smoke passed — checkpoint closed

`/tmp/orca-ota-e2e/android-terminal-session-integration.log` exited 0 with `ok: true`.
It covers installed-shell startup/pairing, hosted workspace/session activation,
privacy, Tasks/error presentation, terminal native links and Source Control/Review.
This Android harness does not specifically exercise the new settings UI. The owned
headless emulator was stopped; both platform harnesses have exited.

The optional OTA crash-loop fixture was archived under
`/tmp/orca-review2/deferred-ota-fixture/`, with its runner wiring removed from the
worktree. Existing production rollback is unchanged. The actual Terminal report
field is committed as `4f95f2f31d3`. No pushes.

Next necessary implementation remains session snapshots/feeds and other domain
consumers, then Voice/notification/diagnostic presentation. Native process-death
resume enhancements and the additional crash-loop drill remain deferred. About
and session creation have unit/integration coverage but no dedicated rendered
interaction proof in this checkpoint.
