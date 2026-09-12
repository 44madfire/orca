# SNC1.6 Manual Gate — images + model/thinking + prompts (fork dev branch)

Target: `44madfire/orca` branch `snc1.6-external-bridge-images-options`
(@ `6a84e2c1d4`, 29 headless tests green).
Provider proof: `44madfire/orca-pi` branch
`44madfire/snc1.6-add-model-thinking-controls-interactive-p-2`
(@ `d36e450` + UI1.2 base `4d31921`, 980 tests green: 27 SNC1.6 + 144 bridge + full suite).

This supplements `MANUAL-GATE.md` (SNC1.3 Gates 0–6, still valid).
Do not re-run SNC1.3 gates here — this gate proves only the SNC1.6 delta:
structured images, shared model/thinking controls (no renderer fork),
and interactive prompts. `models:[]` remains explicitly SNC1.8
catalog-seam follow-up (bridge v1 has no catalog response; never claim
list-complete).

## 0. Prerequisites

```sh
cd C:/orca-fork
git branch --show-current        # expect: snc1.6-external-bridge-images-options
git rev-parse HEAD               # expect: 6a84e2c1d4 (or newer documented)
git status --short               # expect: clean

# orca-pi provider (Pi-backed + mock, already built for this gate):
ls "C:/Users/jeffr/orca/workspaces/orca-pi/snc1.6-add-model-thinking-controls-interactive-p-2/packages/structured-bridge/dist/pi-provider-cli.js"
ls "C:/Users/jeffr/orca/workspaces/orca-pi/snc1.6-add-model-thinking-controls-interactive-p-2/packages/structured-bridge/dist/mock-provider-cli.js"
# Pi binary for Pi-backed runs:
which pi && pi --mode rpc --help 2>&1 | head -n 5
```

SNC1.3 `MANUAL-GATE.md` §3.5 still applies (structured chat flags,
folder workspace `<WS>`/`<ROOT>`, `opId()` helper, group `parentPath`).
Reuse the same `canon`/`fp`/`call`/`opId` helpers and
`agentSession.ensure` shape with `provider:'external', agent:'external'`.

## Gate 0 — automated suites (must stay green)

```sh
# Fork adapter (headless, no Pi, no Electron):
cd C:/orca-fork
./node_modules/.bin/vitest run --config config/vitest.config.ts src/main/native-chat/agent-session-wire/external
# expect: 2 files, 29 passed (18 SNC1.3 + 10 SNC1.6 + 1 reacquire regression)

# orca-pi provider (headless, fake Pi RPC + BridgeHost E2E):
cd "C:/Users/jeffr/orca/workspaces/orca-pi/snc1.6-add-model-thinking-controls-interactive-p-2"
npm run build
npm test -- packages/structured-bridge/test/pi-provider-snc16.test.ts
# expect: 27 passed (images/options/prompts + BridgeHost E2E + deadline races)
npm test -- packages/structured-bridge/test/
# expect: 7 files, 144 passed
```

If Gate 0 fails, stop — fix before touching Gates 1–5.

## Gate 1 — mock images via normal Native Chat dispatch

Boot:

```sh
cd C:/orca-fork
export ORCA_PI_BRIDGE_COMMAND="node C:/Users/jeffr/orca/workspaces/orca-pi/snc1.6-add-model-thinking-controls-interactive-p-2/packages/structured-bridge/dist/mock-provider-cli.js"
pnpm run build
pnpm dev -- --enable-external-structured-bridge
```

In devtools console (after `ensure` per MANUAL-GATE.md §4):

```js
// Attach a small png already in the workspace (authorized attachment path):
const body = { kind:'message', role:'user', blocks:[
  { type:'text', text:'describe this attachment' },
  { type:'image-ref', path:'<ROOT>/small.png' }
]};
const senv = { sessionId, clientOperationId: opId(), expectedRuntimeFence: fence,
  payloadFingerprint: await fp('agentSession.send', sessionId, { body }) };
await call('agentSession.send', { envelope: senv, body });
await call('agentSession.history', { sessionId, direction:'tail', limit:40 });
```

**Pass:**
- `send` → `accepted` (no `image blocks unsupported (SNC1.6)` — that temp is gone).
- Assistant streams mock reply in the normal bubble; history shows prompt
  text but **no base64 substring** (text-only history, bytes never journaled).
- Oversize/URL/missing cases fail closed (try `path:'https://x/y.png'` →
  `rejected: image URL refs unsupported`; try missing file → `rejected:
  image unreadable`; session stays usable).

## Gate 2 — mock model/thinking via shared option UI (no renderer fork)

```js
// current (provider-confirmed get_session metadata):
await call('agentSession.options', { sessionId, fence });
// expect: { models: [], current: { model: <qualified or 'external'> } }
// models:[] is honest SNC1.8 follow-up — do NOT expect a catalog here.

// set qualified ref (exact, no fuzzy):
await call('agentSession.setOption', { sessionId, fence, key:'model', value:'mock-provider/mock-model' });
// expect: ok; follow-up options call reports the same qualified ref.

// bare/unknown fail closed:
await call('agentSession.setOption', { sessionId, fence, key:'model', value:'nope-unknown' });
// expect: clean error (UNKNOWN_MODEL), session still usable.
await call('agentSession.setOption', { sessionId, fence, key:'thinkingLevel', value:'nope-level' });
// expect: clean error (UNKNOWN_THINKING_LEVEL), no Pi semantics touched.
```

**Pass:** current comes from `get_session`, set forwards exact qualified
`provider/modelId` (duplicate bare IDs require qualified form;
`AMBIGUOUS_MODEL` fails closed), failures surface as toasts + TUI fallback.
Fence isolation: `ensure` a second session → its options do not leak into
the first (per-session, no cross-`acquire` leak).

## Gate 3 — mock prompts via normal affordances

The mock provider used in headless tests emits `prompt_request`
(select/confirm/input/editor). In the dev app:

- `select`/`confirm` renders as approval/question dialog; answering via the
  normal affordance calls `answerPrompt()` → `BridgeHost.answerPrompt(requestId)`
  after Orca durable CAS.
- Answer once → resolves; answer same item again → `unknown prompt item`
  (stale/late → `UNKNOWN_REQUEST` provider-side, never re-sent).
- `notify`/`setTitle`/unknown kinds never block the turn (bounded ignore).

**Pass:** dialogs render/answer through normal prompt affordances;
exactly-once holds; retirement on settle/cancel/exit is provider-side.

## Gate 4 — Pi-backed pixels (real Pi, optional final gate)

```sh
export ORCA_PI_BRIDGE_COMMAND="node C:/Users/jeffr/orca/workspaces/orca-pi/snc1.6-add-model-thinking-controls-interactive-p-2/packages/structured-bridge/dist/pi-provider-cli.js"
# relaunch: pnpm dev -- --enable-external-structured-bridge
```

Repeat Gates 1–3 with a real model:

- `get_available_models` gives qualified refs (e.g.
  `openai-codex/gpt-5.6-luna`); bare `gpt-5.6-luna` with duplicates →
  `AMBIGUOUS_MODEL` (must use qualified form); qualified set → `get_session`
  confirms it.
- Images: supported model → structured `images[]` reaches Pi
  (`prompt.images`, opaque base64, no re-encode); text-only model →
  actionable `rejected(model-rejects-images: …)` + toast + TUI fallback,
  session stays usable; `unknown` reconciles via history, never auto-resends.
- Prompts: real `extension_ui_request` (where the model emits one) renders
  as above; `answer_prompt` exactly-once, stale → `UNKNOWN_REQUEST`.

If Pi auth/offline blocks this gate, record `pi --mode rpc` smoke output
and keep the mock Gates 1–3 as the blocking proof (per handoff, dev-app
pixels are optional final gate only).

## Gate 5 — fallback + teardown (unchanged, re-confirm)

- Missing/incompatible bridge → `probeSupport(){available:false}` → Pi TUI
  untouched; packaged Orca never requires the bridge.
- No secrets/env over the bridge; no prompt text in errors (codes + opIds only).
- Production codex/claude path untouched; teardown joins Orca teardown
  (`release` + bounded dispose, no resident helper — `ps | grep -c mock`
  → 0 after tab close).

## Report format

Per gate: commands run, observed `accepted`/`rejected`/`unknown` shapes
(paste exact reason strings), PASS/FAIL. On failure add: minimal repro,
which gate, whether Gate 0 is still green, exact error text. Post to
`44madfire/orca-pi#16` and link the fork commit SHA + `vitest .../external`
output. Explicitly mark any remaining `models:[]` / image-gate scope as
SNC1.8 if not claimed complete (currently: `models:[]` is SNC1.8;
image gate is done).
