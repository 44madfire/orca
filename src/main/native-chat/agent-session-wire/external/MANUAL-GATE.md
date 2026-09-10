# SNC1.3 Manual Gate — agent handoff

You are operating in the Orca fork to prove the hot-swappable external
structured-session bridge end to end. Work through the gates in order.
Everything here is **dev-branch only** — see §1 rules before touching code.

## 0. Mission

Prove (issue `44madfire/orca-pi#13`, §4 + acceptance criteria):

1. A mock external provider creates a **real Orca structured session**
   (record store + journal + lease + host) through the external adapter.
2. A prompt dispatched from normal Native Chat streams a fake response into
   the **normal Native Chat UI**.
3. The provider restarts independently of Orca; stale sessions fail closed
   and require explicit re-acquire.
4. Missing / incompatible / malformed / exited / errored bridge falls back
   safely to ordinary Pi TUI behavior (no crash, no resident helper).
5. Teardown leaves no helper process, pending waiter, or duplicate owner.
6. The branch still applies on current upstream `main`.

## 1. Rules (read before doing anything)

- **Fail closed, never fail open.** If a check behaves unexpectedly, stop and
  record it — do not "fix" the gate by weakening validation, widening a
  schema beyond §7, auto-retrying `unknown` dispatches, or impersonating
  another provider's handle.
- **No Pi imports Orca-side.** `src/main/.../external/` may import only the
  vendored bridge + Orca contracts. Pi mapping lives in `orca-pi`.
- **Dev-branch only.** Never commit to `main`. Force-push only
  `snc1.3-external-structured-bridge`. Keep diffs minimal and provider-neutral.
- **After any code change**, re-run the affected suites in §3 before
  re-attempting a gate.
- **Windows/MAX_PATH is load-bearing.** This repo MUST stay at a short path
  (`C:\orca-fork`). Never move it deeper; native rebuilds die at 260 chars
  (see error catalog). Git Bash is the shell below unless noted.

## 2. Environment facts

| Fact | Value |
|---|---|
| Repo root | `C:\orca-fork` (fork `44madfire/orca`) |
| Branch | `snc1.3-external-structured-bridge` |
| Upstream base | `stablyai/orca@f2d5711b` (drift: additive-only, §9) |
| orca-pi checkout | `C:\Users\jeffr\orca\workspaces\orca-pi\snc1.3-add-hot-swappable-external-structured-ses` |
| Mock provider | `<orca-pi>/packages/structured-bridge/dist/mock-provider-cli.js` (build it: `npm run build` in orca-pi) |
| Dev flag | `--enable-external-structured-bridge` (main-process argv) |
| Bridge command env | `ORCA_PI_BRIDGE_COMMAND` (explicit path only, never a manifest) |
| pnpm | `C:\Users\jeffr\AppData\Roaming\npm\pnpm` (add to PATH) or `corepack prepare pnpm@latest --activate` |
| Tracking | fork PR `44madfire/orca#1` (draft) → upstream later; `44madfire/orca-pi#13` holds the checkboxes |

Verify you are here before starting:

```sh
cd C:/orca-fork
git branch --show-current        # expect: snc1.3-external-structured-bridge
git log --oneline -1            # expect: 66efda47 (or newer documented commit)
git status --short              # expect: clean (or only your intentional edits)
ls packages 2>/dev/null; ls node_modules/.bin/vitest  # expect: vitest present (post-install done)
```

## 3. Gate 0 — automated suites (fast, must stay green)

```sh
cd C:/orca-fork
export PATH="$PATH:/c/Users/jeffr/AppData/Roaming/npm"
pnpm vitest run src/main/native-chat/agent-session-wire/external
# expect: 18 passed (incl. live-process mock E2E ~6s)
pnpm vitest run src/main/native-chat/agent-session-wire/structured-agent-session-adapter-router.test.ts \
  src/shared/agent-session-provider-handle.test.ts
# expect: 32 passed (6 router unchanged + 26 handle incl. 3 external chain cases)
```

```sh
cd <orca-pi>
npm run build && npm test -- packages/structured-bridge && npm run lint
# expect: bridge suites pass, lint clean
```

If Gate 0 fails, fix it before touching Gates 1–5.

## 4. Gate 1 — create a real session through the adapter

Boot the stack (first build is long; native modules are already rebuilt):

```sh
cd C:/orca-fork
export ORCA_PI_BRIDGE_COMMAND="node C:/Users/jeffr/orca/workspaces/orca-pi/snc1.3-add-hot-swappable-external-structured-ses/packages/structured-bridge/dist/mock-provider-cli.js"
pnpm run build
pnpm dev -- --enable-external-structured-bridge
```

Get a real workspace id + root from the dev-built CLI (substitute below as
`<WS>` / `<ROOT>`):

```sh
node ./out/cli/index.js worktree list --json
```

In the dev build's devtools console (`window.api.runtime` is the preload RPC
bridge — verified in `src/renderer/src/runtime/runtime-rpc-client.ts`).
Paste the helper once:

```js
const canon = v => v===null||typeof v!=='object' ? JSON.stringify(v??null)
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : `{${Object.entries(v).filter(([,e])=>e!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,e])=>`${JSON.stringify(k)}:${canon(e)}`).join(',')}}`;
const fp = async (method, sessionId, fields) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(canon({method, sessionId, fields}))))].map(b=>b.toString(16).padStart(2,'0')).join('');
const call = (method, params) => window.api.runtime.call({method, params});
```

Create the session (entry point: client-supplied-location `ensure`;
worktree-intent create is intentionally claude/codex-only until SNC1.4):

```js
const sessionId = 'external_' + crypto.randomUUID().replaceAll('-','');
const base = { location:{executionHostId:'local',wslDistro:null,workspaceId:'<WS>',workspaceKind:'folder'},
  provider:'external', agent:'external',
  accountHome:{variable:'EXTERNAL_BRIDGE_DIR', path:'<ROOT>'}, runtimeKind:'native' };
const envelope = { sessionId, clientOperationId:crypto.randomUUID(), expectedRuntimeFence:null, payloadFingerprint:'' };
envelope.payloadFingerprint = await fp('agentSession.attach', sessionId,
  {...base, providerHandle:undefined, adoptedProviderHandle:undefined, expectedRuntimeFence:null});
const created = await call('agentSession.ensure', {...base, envelope});
```

**Pass:** `created.ok === true` with a `fence`. This is a REAL session:
durable record (`provider:'external'`), journal, lease, host-owned.
**Fail shapes:** `structured_agent_session_unsupported` → flag/env missing
(§6.4); fingerprint refusal → recompute exactly per the field set above
(extra keys change the digest).

## 5. Gate 2 — stream into the normal Native Chat UI

```js
const fence = created.fence;
const body = {kind:'message', role:'user', blocks:[{type:'text', text:'hello native chat'}]};
const senv = {sessionId, clientOperationId:crypto.randomUUID(), expectedRuntimeFence:fence,
  payloadFingerprint: await fp('agentSession.send', sessionId, {body})};
await call('agentSession.send', {envelope:senv, body});   // expect accepted
await call('agentSession.history', {sessionId, direction:'tail', limit:40});
// expect an assistant item whose text is "mock response for: hello native chat"
```

**Pass:** the fake reply renders in the Native Chat bubble and input
re-enables on `settled`. (Heads-up: image blocks are rejected fail-closed
until SNC1.6 — text only for this gate.)

## 6. Gate 3 — independent provider restart

```sh
ps | grep mock-provider-cli     # note the PID; Orca stays running throughout
kill <pid>
```

Back in console: `send` again → expect `rejected: bridge-unavailable`
(definite refusal, **never** auto-respawned or auto-resent). Start a fresh
mock, `ensure` a **new** session id → works. The old session id stays
failed-closed (re-acquire explicitly; stale never silently resumes).

## 7. Gate 4 — fallback matrix

For each row: attempt `ensure`, expect a clean refusal/error, the Pi TUI
path offered, **no session created, no process left behind**.

| Case | Command (new shell, then re-run Gate 1 `ensure`) |
|---|---|
| Missing binary | `export ORCA_PI_BRIDGE_COMMAND=/nonexistent/mock.js` |
| Incompatible | `export ORCA_PI_BRIDGE_COMMAND="node -e \"require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.kind==='hello')process.stdout.write(JSON.stringify({v:1,kind:'hello_error',opId:m.opId,error:{code:'INCOMPATIBLE_PROTOCOL',message:'nope'}})+'\n')})\""` |
| Malformed | mock that prints `not json` (expect ~5s hello-timeout failure) |
| Exited mid-session | `kill -9 <mock-pid>` after Gate 2, then `send` → rejected |
| Errored turn | send text `__throw__` via the mock → `turn_end{error}` + generic `provider dispatch failed` status (never raw exception text) |

Restore the good `ORCA_PI_BRIDGE_COMMAND` afterwards.

## 8. Gate 5 — teardown

Close the tab, then:

```sh
ps | grep -c mock-provider-cli    # expect: 0
```

Re-`ensure` the old id at its last fence → ownership refusal (no duplicate
owner). Status feed no longer lists the session. `node_modules` DLLs must
not be locked by stray processes (that failure mode is §9.2).

## 9. Gate 6 — rebase / drift check

```sh
git fetch upstream main
git diff --stat <base> upstream/main -- src/shared/agent-session-wire.ts \
  src/shared/agent-session-journal-types.ts \
  src/main/native-chat/agent-session-wire/structured-agent-session-adapter.ts \
  src/main/native-chat/agent-session-wire/structured-agent-session-event-sink.ts
```

Drift so far has been additive-only (background-task fields, submission
`fence`/`recovered`). If a drift touches acquire/dispatch/option/sink
semantics, re-validate the adapter + re-run §3 before claiming the gate.

## 10. Error catalog (seen before — check here first)

1. **`ERR_PNPM_EXECUTOR_LIFECYCLE_SCRIPT_FAILED` / `FTK1011 ... The system
   cannot find the path specified`** → path hit 260 chars. Confirm:
   measure the path; fix is moving the repo shallower (done: `C:\orca-fork`),
   never deeper. Do not "fix" by skipping the rebuild.
2. **`ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR ... os error 5`** →
   transient lock (Defender scan or a racing process). `rm -rf node_modules`,
   retry `pnpm install`. If persistent, find the holder before retrying.
3. **`TSConfckParseError ... tsconfig.node.json`** from vitest → you ran
   outside the repo context. In-repo now works post-install; the
   copy-to-clean-dir trick is obsolete, do not reintroduce it.
4. **`structured_agent_session_unsupported` on `ensure`** → dev flag absent
   from the *main* process argv, or `ORCA_PI_BRIDGE_COMMAND` empty. Both are
   read live per acquire — no rebuild needed, just relaunch/fix env.
5. **Fingerprint refusal** → payload differs from `attachFingerprintFields`
   + `agentSession.attach` method string. Recompute per §4; never add/omit
   keys.
6. **`pnpm` not found** → PATH lacks `C:\Users\jeffr\AppData\Roaming\npm`,
   or `corepack prepare pnpm@latest --activate`.
7. **tsc `Property 'refusal' does not exist`** under a bare `tsc` run →
   pre-existing toolchain artifact (verified via stash), ignore unless repo
   CI flags it.
8. **Dispatch `unknown`** → reconcile via `history`, confirm with the user
   before any retry. Never auto-resend — that rule is the whole point of
   the honest-dispatch contract.

## 11. Report format

Per gate record: commands run, observed output (paste exact refusal/receipt
shapes), PASS/FAIL. On failure add: minimal repro, which gate, whether
Gate 0 is still green, and the exact error text. Post the summary to
`44madfire/orca-pi#13` (checkboxes live there) and link the fork commit.

## 12. Stop / escalate

- Stop and report (do not restructure) if: a gate needs worktree-intent,
  tab pickers, TUI handoff, images, resume, or model catalogs — those are
  SNC1.4–SNC1.9 scope, explicitly out of this seam.
- Stop and report if upstream drift touches adapter/sink/option semantics.
- You may fix bugs inside `.../external/`, extend its tests, and amend docs.
  Shared-file changes beyond the current diff need a stated reason.
- Never commit to `main`; force-push only the feature branch.
