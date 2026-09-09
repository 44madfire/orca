# Agent status store

## Status

Proposed on 2026-09-09 as the follow-up to #19217. It lands in three PRs, in
this order, each independently shippable:

1. main-only: every producer writes into one store and `worktree ps` reads it;
2. renderer: the sidebar becomes a subscriber and stops re-deriving rows;
3. shared: one worktree-status rollup and one freshness rule for every reader.

The PR that carries this document is PR 1.

## The problem this solves

Orca shows "what is this agent doing" in four places: the desktop sidebar, the
`orca worktree ps` command, the mobile app, and the agent dashboard. Before
#19217 those readers did not even share their inputs. After #19217 they share
the structured-session mapping and nothing else.

An audit on 2026-09-09 found six producers and three consumers, and three
separate copies of the same row inside the main process alone:

| Main-process copy                      | Keyed by  | Owned by                                                   | Persisted           | Evicted                       |
| -------------------------------------- | --------- | ---------------------------------------------------------- | ------------------- | ----------------------------- |
| hook server `lastStatusByPaneKey`      | paneKey   | `src/main/agent-hooks/server.ts`                           | `last-status.json`  | tab close, pty exit, hydrate  |
| runtime `RuntimeAgentRowStore`         | paneKey   | `src/main/runtime/runtime-agent-row-store.ts`              | no                  | pty exit only                 |
| structured feed `published`            | sessionId | `src/main/native-chat/agent-session-wire/structured-agent-session-status-feed.ts` | no  | never (a broadcast cache)     |

The second copy is a duplicate write: the OSC status parsed in main is
forwarded to the hook server _and_ retained in the runtime store from the same
call (`orca-runtime-create-terminal-side-effect-command-code-detector.ts`).
The third copy is keyed differently and never reaches the hook server at all,
which is why `worktree ps` grew its own adapter for it in #19217.

Each reader then applies its own precedence and freshness rules, so the same
pane can legitimately read differently on the desktop, on the phone, and in
the CLI.

## The rule

**The execution host owns agent status, in one store, and every reader
subscribes to it.** This follows the boundary in
[`ssh-execution-boundary.md`](./ssh-execution-boundary.md): the host that runs
the process is the only party that can observe it, and the client is never
authoritative for execution state.

Three consequences:

- One store per execution host. A remote host keeps its own store and the
  client mirrors it down, as the web-session mirror already does. Mirroring is
  not merging: a client never writes its observations back to a host.
- Precedence is decided once, at write time, with provenance recorded on the
  row. Readers never re-adjudicate hook versus terminal versus structured.
- Readers keep only presentation policy and user facts: the 30-minute display
  decay, acknowledgements, dismissals, unread. Those stay reader-side but
  become one shared implementation (PR 3).

## The store already exists

The hook server's state is that store today for every PTY-based agent. The
audit established:

- hook HTTP posts, the WSL and SSH relay receivers, and main's own OSC parse
  all converge on the same `applyNormalizedStatus` path, stamped with the
  authority id `main-agent-hooks`;
- it alone holds pane authority: launch tokens and their hashed commitments,
  retired-pane fences, pane-key aliases, per-connection ordering watermarks,
  and the evidence-age map that must outlive a transport clear;
- it alone persists, with a seven-day hydrate window and the
  `restoredUnconfirmed` stamp that keeps a hydrated row from ever reading as
  live truth;
- it already fans out to both renderer windows over `agentStatus:set` and
  `agentStatus:clear`, and serves `agentStatus:getSnapshot`.

Nothing else in main carries those guarantees, and building a second store
with them would be the wrong direction. So the design is not "add a store". It
is: **route the two producers that bypass the hook server through it, then
delete the copies.**

## PR 1: main only

No renderer behavior changes. The sidebar keeps receiving the same IPC events
it receives today, plus structured-session rows it currently derives itself.

### Structured sessions publish into the hook server

The structured feed keeps its job of projecting a session's journal into a
summary and streaming it to subscribers. On every publish it additionally
ingests the summary into the hook server as a status row:

| Row field         | From                                                          |
| ----------------- | ------------------------------------------------------------- |
| `paneKey`         | `structuredAgentSessionPaneKey(tabId, sessionId)`, the key the renderer already uses; its leaf is UUID-shaped so pane-key validation accepts it |
| `tabId`           | `structuredAgentSessionTabId(sessionId)`                      |
| `worktreeId`      | `summary.workspaceId` (a folder workspace id is a valid value) |
| `state`           | `structuredAgentSessionStatusState(summary.status)`, the mapping #19217 shared |
| `source`          | `'structured-host'`                                           |
| `structuredHostOwned` | present while `summary.hostExecutionOwned` is present     |
| prompt, tool, last message, model, provider session | the summary's fields    |

Sessions with no persisted turn (`status === null`) produce no row, matching
what the chat shows. When the host revokes live ownership the row is re-set
without the flag; when the host closes or evicts the session the row is
dropped. Both already exist as feed events (`revokeLive` and the roster
filter in `liveSessionSummaries`); PR 1 turns them into store writes.

Two rules the ingest must keep:

- **Never persist a structured row.** The journal is the durable truth for a
  structured session and the host republishes on restore. A structured row in
  `last-status.json` would hydrate as `restoredUnconfirmed` and then fight the
  live republish. The serializer skips rows whose source is `structured-host`.
- **Never let it fight a hook row.** A structured session has no PTY, so no
  hook or OSC event carries its pane key. The ingest still goes through the
  disposition gate so a retired pane key is refused like any other.

The ingest lives in the feed, not in `structured-agent-session-host.ts`, which
sits at the file-length cap.

### The runtime's retained row store is deleted

`RuntimeAgentRowStore` keeps the same payload the hook server already holds.
Its only extra is the pty id, used to clear rows on exit and as a fallback key
for the mobile projection. PR 1 stamps `terminalHandle` on OSC-ingested rows
from the runtime event's `ptyId`, and rewrites the three readers over the hook
server's snapshot:

- `worktree ps` reads `getStatusSnapshot()` directly;
- `getFreshExplicit` already consults hook rows; it drops the retained input;
- `getFreshForMobile` matches on pane key, then on `terminalHandle`.

One behavior change follows and is intended: a row the user dismisses on the
desktop disappears from `worktree ps` and the phone at the same time, instead
of lingering until the pty exits.

### `worktree ps` becomes a reader

`collectRuntimeWorktreePtyAgentSources` loses its retained-versus-hook
reconciliation, because there is one row per pane. The structured adapter
added in #19217 is deleted. What remains is one adapter from the store's
snapshot to `RuntimeWorktreeAgentSource`, plus the admission gate that decides
which rows a worktree listing may show:

- a hook or OSC row needs its tab mirrored or a connected pty, as today, and
  SSH rows stay exempt because their tabs may exist only remotely;
- a `structured-host` row is admitted while the host holds the session, and
  the host's drop on close is what removes it; no tab-mirror requirement,
  because headless serve has no renderer to mirror tabs from.

The freshness bypass for host-owned structured rows already exists in
`isFreshNonDoneAgentStatus`; with the flag now on the row it becomes the only
path, and the hand-rolled check in `runtime-worktree-agent-rows.ts` goes.

### Wire compatibility

`AgentStatusIpcPayload` gains one optional field, `structuredHost`, and the
`worktree ps` row gains `structuredHostOwned`. Under rule 1 of
[`remote-wire-compatibility.md`](./remote-wire-compatibility.md) both are safe:
an old client ignores them. `worktree ps` rows keep their shape and vocabulary,
so the mobile app sees no change.

Until PR 2 the main process does not forward structured rows to the renderer
over `agentStatus:set` or `agentStatus:getSnapshot`. The renderer's feed
bridge still writes those rows itself, and forwarding them too would give one
pane key two writers. Removing that filter is the first step of PR 2.

## PR 2: the renderer subscribes

With structured rows arriving over `agentStatus:set`, the renderer's
`StructuredAgentSessionStatusBridge` no longer needs to write status; its
unmount cleanup becomes a tab-close signal to the host. The IPC applicator is
the single writer for observed status. The 2026-09-09 audit sorted the other
writers:

| Writer                                                          | Disposition                                        |
| --------------------------------------------------------------- | -------------------------------------------------- |
| Command Code output seeds, parked-pane seeds, pty-exit removal  | delete; main already emits the same facts          |
| structured bridge status writes                                 | delete; main now publishes the row                 |
| launch placeholder seeds (a user launched an agent with a prompt) | keep for now; main holds the launch config and can seed later |
| dismissal, acknowledgement, unmount                             | keep; user facts and component lifecycle           |
| remote-runtime OSC parse (bytes never transit local main)       | keep, fenced behind the host's published row once the host is new enough; rule 3 of the wire doc applies |
| web-session mirror receipt clock                                | keep; the decay rule needs both clocks from one machine |

The Command Code done-settle window is renderer policy with no main
equivalent. PR 2 either moves it into main's detector or leaves it, and says
which.

## PR 3: one rollup, one clock

The worktree card status is derived three times: `lib/worktree-status.ts` in
the renderer, `runtime-worktree-status-projection.ts` in main, and
`agent-row-display.ts` in mobile, which hand-copies the 30-minute constant.
PR 3 moves the rollup and the decay into `src/shared` and makes all three
call it.

## What does not change

- The hook scripts, the OSC 9999 wire format, and the relay protocol.
- The status vocabulary. `working / blocked / done` for rows,
  `working / attention / idle` for structured summaries, mapped once.
- The `live / unverifiable / exited` verdicts for remote work. Loss of contact
  clears nothing; the SSH exemptions in the admission gate stay.
- Hydration honesty: a restored non-done row is `restoredUnconfirmed` and is
  never fresh.

## Verification

- Unit: ingest a structured summary and read it back through
  `getStatusSnapshot`, `worktree ps`, and the mobile projection; assert the
  serializer never writes a `structured-host` row; assert a hydrated file that
  somehow contains one is dropped.
- Unit: the existing `worktree ps` suites pass unchanged, which is the
  characterization that deleting the retained store changed no listing.
- Live: the parity check from #19217 (working, done, close, reload) repeated
  against the merged store, with both surfaces read from the one row.
