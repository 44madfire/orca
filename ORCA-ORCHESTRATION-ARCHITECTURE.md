# Orchestration architecture follow-up

## Decision

The long-term fix should separate execution evidence from its presentation. A
terminal title is a lossy display projection. It may be retained as compatibility
evidence for providers that do not expose a stronger protocol, but it must not be
the owner of agent identity, prompt acceptance, process liveness, or Dispatch
completion.

The merged per-PTY mailbox index is useful performance work, but it is only
defense in depth. The architectural change should make mailbox reservation
lifecycle own recovery eligibility and make one evidence-selection policy serve
terminal status, interactive-wait, and prompt-submission decisions.

## Root causes

Two ownership problems are coupled:

1. Every working or permission title currently calls mailbox recovery. Animated
   titles therefore perform durable cleanup even when no reservation exists. The
   index reduces the cost of that cleanup but leaves the title handler responsible
   for a mailbox decision it does not own.
2. Status consumers reduce different evidence independently. A live permission
   title can override a newer working hook, while another consumer applies a
   different precedence rule. Repeated snapshots and reconnects can look newer
   by delivery time without representing a new provider transition.

Neither problem is solved by adding another title regex, a transition-only guard,
or a timeout. A reservation can be created after the last working edge, survive a
restart, or remain ambiguous while a write is settling. A status snapshot can be
replayed after reconnect. Those cases require durable ownership and provenance.

## Target architecture

### Evidence reduction

Create one internal evidence reducer for terminal activity and permission:

- Keep identity, activity, permission wait, process verdict, and Dispatch
  completion as separate facts.
- Prefer current-incarnation explicit hook transitions over older title evidence.
- Keep a genuine later permission event, equal-time permission evidence, and
  approval text with unknown transition age conservative.
- Treat replayed or snapshot observations as restatements, not new transitions.
- Preserve the evidence source, authority, incarnation, observation kind, and
  receipt time internally. Do not compare title sequence numbers with epoch
  timestamps.
- Reuse the existing lifecycle-generation and observation envelopes. Do not add a
  parallel identity registry.
- Fence asynchronous process probes and in-flight requests by PTY lifecycle
  generation. A replacement process using the same PTY ID must reject the old
  result.

Title parsing remains a fallback for legacy terminal CLIs. Synthetic titles remain
a presentation compatibility path until hook provenance can flow directly to all
consumers and mixed-version clients safely.

### Mailbox recovery

The mailbox delivery subsystem owns pending-reservation recovery:

- Register the durable reservation before transport I/O, with database identity,
  target PTY, process incarnation, message IDs, and phase.
- Hydrate pending reservation ownership when a database is attached or replaced.
  A negative in-memory result is authoritative only after hydration.
- Invalidate derived eligibility before every mutation boundary that can clear or
  create a pointer reservation, including stage, phase transitions, inbox
  mutations, acknowledgments, reset transactions, and database replacement.
- Never cache absence while an outer transaction may still roll back.
- Remember that working evidence arrived during an active flight. When that flight
  settles, reconcile its reservation directly; do not require another title frame.
- Keep attempted writes conservative. A possibly delivered paste or Enter is not
  replayed automatically for the same incarnation.
- Bound derived memory by active reservations and ensure every flight, timer, and
  callback is cleared on settlement, refusal, teardown, and generation change.

The database phases remain authoritative. The projection is only a disposable,
database-derived eligibility optimization. It must never become a second source of
truth.

## Scope for the focused implementation

The current follow-up should include:

- the mailbox reservation projection and all relevant mutation invalidation
  boundaries;
- flight reservation identity and observation-before-settlement recovery;
- the shared terminal evidence selector and its terminal status and
  interactive-wait consumers;
- lifecycle-generation fencing for status probes;
- source-owned local receipt time for native PTY and leaf title observations;
- deterministic tests for restart, rollback, ambiguous settlement, replacement
  incarnations, stale permission titles, genuine later permission, replayed
  snapshots, and zero steady-state recovery SQL;
- the existing reliability/performance contract and this design record.

It should not include a new wire opcode, relocation of SSH mailboxes, a rewrite of
all renderer projections, replacement of terminal CLIs with a structured harness,
or unrelated product/UI changes.

## Validation contract

The invariant is: status decisions and pointer recovery use evidence owned by the
correct lifecycle, while display updates remain cheap and non-authoritative.

Required deterministic oracles:

- thousands of repeated decorative title observations issue no recovery SQL when
  there is no pending reservation;
- a reservation created after an earlier working observation is still recovered;
- working observed during an unsettled flight reconciles after settlement;
- rollback, restart, database replacement, and reset never leave a cached absence;
- old permission title plus newer working transition clears permission;
- refreshed working snapshot does not clear permission;
- newer permission remains blocked;
- same-PTY generation replacement rejects delayed status/probe results;
- exact message IDs and phases retain current ambiguous-write semantics.

Run the existing `orchestration.notification-mailbox-consistency` tests and the
focused runtime tests. Run typecheck and changed-file quality checks. Electron
validation, when needed, must exercise the real rendered surface through hidden
CDP with `ORCA_BACKGROUND_LAUNCH=1`; a startup screenshot alone is not evidence of
title-driven recovery. SSH, WSL, Windows, relay, and mobile gaps must be reported
explicitly when not exercised. Disconnect remains `unverifiable`, never `exited`.

## Later migration

The next architectural step is to carry typed hook/session evidence directly from
its admitted execution owner to runtime consumers. The owner should publish
identity, transition, permission, and completion separately; the UI may derive a
title from those facts, but runtime control paths should not parse that title back.
Legacy title evidence remains necessary until provider support and mixed-version
compatibility are proven. Structured sessions have stronger lifecycle ownership,
but their admission and acknowledgement protocol cannot be assumed for arbitrary
PTY-launched CLIs.
