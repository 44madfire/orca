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

## Current checkpoint

- [x] Investigate shell/host/page coupling and re-derive host-method census.
- [x] Pin bridge protocol 2 and installed/cached package admission: `11646f11e0f`.
- [x] First complete generic unary slice: `9910fccc298`.
      Desktop catalog, opaque workspace binding, source-control status/diff,
      page-side presentation, legacy fallback, hard payload and concurrency bounds.
- [x] Directory and binary chunk reads use generic forwarding: `a8bbed52da4`.
- [x] File lists/search/text use Desktop privacy adapters: `31024ff0316`.
- [ ] Complete the generic bridge and migrate remaining domain consumers.
- [ ] Complete iOS end-to-end evidence and Android final smoke check.

Prior investigation and exact gate tails are currently preserved in
`/tmp/orca-review2/codex-ota-investigation.md` and
`/tmp/orca-review2/codex-ota-report.md`. This tracked file is the ongoing status
source; it must not depend on those temporary files to explain remaining work.

## 1. Establish a reproducible mobile test baseline

- [x] Inventory iOS and Android devices and existing app installations.
      iOS: iPhone 17 Pro, iOS 26.5, `DC47C924-6602-497C-BE01-4C80EB391E20`.
      Android AVDs: `OrcaAttachApi36`, `Pixel_9_Pro_API_36`; initially stopped.
- [x] Run the focused iOS hosted-WebView Files/Preview journey against this
      worktree's built Desktop/page and shell. Full combined journey remains open.
- [x] Keep tests and launched apps under `ORCA_BACKGROUND_LAUNCH=1`; use hidden
      Desktop renderers and emulator automation without activating desktop windows.
- [ ] Preserve an installed shell/page baseline for mixed-version journeys.

## 2. Complete unary forwarding and opaque identity handling

- [ ] Extend host-advertised metadata without freezing new domain schemas into
      the shell. Keep catalog queries bounded, not the lifetime method vocabulary.
- [ ] Support page-safe host-owned opaque handles alongside existing workspace
      handles; retire authority on document/host/client replacement.
- [ ] Preserve intent fingerprints across opaque ID translation. Validate page
      intent before mapping, recompute host fingerprints afterward, and preserve
      clientOperationId, expectedRuntimeFence and retryUnknown.
- [ ] Migrate native-chat reads and host actions, separating image/clipboard/
      pending-storage device actions from domain presentation.
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
- [ ] Preserve direct/relay setup, ready, unsubscribe and reconnect behavior.
- [x] Reuse the existing subscription ledger with bounded pending event bytes
      and event count; enforce aggregate subscription ceilings.
- [x] Forward domain event shapes without APK-owned projections (source-control file watch).
- [ ] Migrate native-chat/session/source-control/account feeds.
- [ ] Preserve terminal binary capability negotiation, acknowledgements,
      backpressure and resync; never silently substitute JSON stream semantics.

Proof: cancellation before ready, synchronous events during subscribe, late
handles, client replacement, overflow and reconnect all retire the right host
work and report a terminal closure to the surviving page.

## 4. Page-owned persistence and routing

- [ ] Add bounded JSON preferences scoped by paired host and namespace; survive
      page build changes and rollback. Keep credential storage inaccessible.
- [ ] Replace hosted AsyncStorage's no-op behavior for page preferences through
      an explicit adapter; do not expose arbitrary native storage keys.
- [ ] Add bounded page-owned resume state and navigation intents, with legacy
      fallback and current host/document fences.
- [ ] Keep notification receipt and host selection native; let the page resolve
      domain routes after readiness. Never persist document-scoped opaque handles
      as though they remain valid after restart.

## 5. Move presentation to hosted routes

Follow `docs/STYLEGUIDE.md`, existing tokens/primitives and shared mobile screen
components. Reuse presentation; split native dependencies through adapters.

- [ ] Native-chat and browser preferences.
- [ ] Terminal settings, including host settings and device preferences.
- [ ] Voice and notification settings; native permission/model actions remain
      explicit capabilities.
- [ ] Settings menu, About, diagnostics and connection-log presentation.
- [ ] Preserve pairing/onboarding bootstrap and minimal offline recovery when
      no trusted healthy page is available.
- [ ] Deliberately update route ownership, reachability and parity tests.

## 6. Remove avoidable package admission coupling

- [ ] Externalize changing inline bootstrap code behind stable native CSP while
      retaining cached-page compatibility.
- [ ] Keep manifest v1 exact keys, canonical hashes and rollback checks intact.
- [ ] Split content-addressed bundles before reaching the 10 MiB single-asset
      ceiling; revise the verifier's single-script assumption if needed.
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

- [ ] iOS: pairing/package activation, workspace/session/chat/terminal/files/
      source-control interactions and migrated settings routes.
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
- Current work: establish emulator baseline and complete generic identity and
  transport primitives before migrating additional page consumers.

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
