# Provider resource diagnostic author report

Status: implementation complete; final compiler slot and committed-source ablations pending. Fresh independent review required before endorsement.

## Requested outcome and failure mechanism

Placement/profile claims can select invocation before the execution host establishes correspondence with the provider resource. This change collects missing correspondence from existing production owners and consumers; it neither removes that architectural failure nor adds a permission guard. Generic provider authority, admission, stop/recovery changes, and ticket-fix claims are outside this PR.

## Functional correctness

Opt in with `ORCA_PROVIDER_RESOURCE_DIAGNOSTICS=1` on the controller and actual managed launch environment. The actual native final spawn environment and relay environment augmenter output feed an execution-owner map. Validated normalized Claude hooks join internal launch-token equality, opaque session correlation, retained root/transcript object metadata, and scoped PTY incarnation/start observations. Wake and legacy AI Vault Resume request source-host diagnostics before destination resolution/preparation, and carry a request ID to actual `pty:spawn` attached/spawned/failed logging. Neither request nor answer gates the existing action.

All resource verdicts remain `unverifiable`. Reported session correspondence, PTY liveness, root-process start time, object witness, provider holder and lifecycle binding are distinct. Changed reported sessions invalidate old transcript correspondence. Hardlinks converge only while an object descriptor is retained; copies differ, replacement and missing records supply no authority.

## Architectural fit

Retention belongs to existing native terminal hosts and relay PTY owners, not renderer panes or a new storage subsystem. It is bounded to 128 records, eight pending probes, one per record and one 15-minute trial per owner. Expiry/disposal releases descriptors; pane projection retirement does not. Queries are targeted; there is no I/O polling or process inventory scan. A retained read descriptor is explicitly historical metadata, not proof that a provider still owns or writes a conversation.

Existing connection authorization is unchanged. SSH uses the selected remote provider with no local fallback. WSL-owned launches/resources and paired runtimes are unsupported. Capability negotiation uses optional JSON metadata; old/missing capability produces `unverifiable`, with no new stream opcode or SQLite dependency. The design is suitable for bounded evidence collection, not yet for replacing invocation ownership.

## Concrete precedent and material deviations

- `terminal-host-session-create.ts` and `pty-subprocess.ts`: reuse actual subprocess creation and transfer final allowlisted launch metadata into its existing host owner.
- `pty-handler.ts`: reuse final relay env augmentation, actual PTY incarnation and retired-incarnation lifecycle; no new controller-side process observer.
- `server-lifecycle.ts` and `agent-hook-server.ts`: tap validated normalized hook delivery before pane cache projection/retirement; self-report remains separate from process proof.
- `agent-session-process-identity-probe.ts`: reuse bounded targeted POSIX start-time reads, while deliberately rejecting the inference from process identity to provider resource authority.
- `daemon-pty-router.ts` and `ssh-pty-provider.ts`: reuse existing authenticated JSON connections and retained native adapters. Same-bundle synthetic transport does not establish cross-version deployment continuity.

## Validation and remaining gaps

The final focused run passed 111 tests in ten files with zero failures. Coverage includes actual native authenticated daemon JSON routing with mocked node-pty, relay normalized HTTP ingress, real wake/legacy AI Vault consumer functions, old bridge behavior, object alias/copy/replacement, generation/session fencing, bounded retention and source-host refusal. All three second-pass typechecks passed sequentially; a final pass is queued after small review edits.

Actual macOS source relay smoke passed 11 assertions each on Node 18.20.8 and Node 24.18.0 with real node-pty, synthetic provider, shipping HTTP normalization and JSON multiplexer. Checks include actual final root, PTY incarnation/start correspondence, provider-closed transcript, hardlink identity, host PTY exit with resource verdict still unverifiable, replacement and recorded fixture PID absence. No provider authentication or real profile was used. The transport is same-bundle and in-memory, not network SSH or a packaged relay update.

No Electron was launched; no rendered or focus-dependent UI was exercised. Native Windows/Linux, WSL, paired runtime diagnostics, cold host restoration, real provider closed-file lifecycle, detached writers, old-writer enrollment, profile/key admission and positive attach authority remain unproven/out of scope. Actions aborting before `pty:spawn` have no eventual spawn outcome.

## Historical failures

The JSON companion enumerates the earlier 16 consumer failures, two fixture failures, three initial node typing errors, one retention-cap timing assertion, and the synthetic dispatcher settlement failure on Node18/24, with their fixes. None are omitted from the validation record. Final ablation evidence and compiler results will be added after the source commit.
