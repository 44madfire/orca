# External structured-session bridge (SNC1.3 dev seam)

> Development/test bridge only. Orca keeps ownership of journal,
> lease/fencing, outbox/idempotency, rendering, and client synchronization.
> This seam lets Pi-specific structured-session logic run **out of process**
> and be **hot-swapped** without rebuilding Electron for every change.

Target: temporary dev branch `snc1.3-external-structured-bridge` on the
writable fork `44madfire/orca` (parent `stablyai/orca`). Small enough to
carry even if upstream declines the generic seam.

## What is here

```text
src/main/native-chat/agent-session-wire/external/
├── bridge-framing.ts                        # vendored LF-only JSONL (from orca-pi)
├── bridge-protocol.ts                       # vendored versioned IPC contract (from orca-pi)
├── bridge-host.ts                           # vendored Orca-side host + providerPid getter
├── external-structured-bridge-config.ts     # dev-only flag + ORCA_PI_BRIDGE_COMMAND
├── external-structured-session-adapter.ts   # StructuredAgentSessionAdapter impl
└── external-structured-session-adapter.test.ts
```

`provider.ts` + mock CLI + `pi-mapping.ts` stay in `orca-pi`
(provider side). Orca core never imports Pi assumptions.

## Dev setup (mock, no Pi)

````sh
# 1. Build orca-pi bridge + mock provider:
cd /path/to/orca-pi
npm ci && npm run build
ls packages/structured-bridge/dist/mock-provider-cli.js

# 2. In this fork, run the external seam tests:
pnpm vitest run src/main/native-chat/agent-session-wire/external

# 3. Manual UI gate (mock over a live OS process):
export ORCA_PI_BRIDGE_COMMAND="node /path/to/orca-pi/packages/structured-bridge/dist/mock-provider-cli.js"
# launch Orca dev with --enable-external-structured-bridge, then create the
# session via client-supplied-location agentSession.ensure (dev console / RPC
# with the agent-session.structured.v1 capability). Fingerprint it exactly as
# the host recomputes it (attach.ts):
# ```ts
# import { computeAgentSessionPayloadFingerprint } from 'src/shared/agent-session-mutation-envelope'
# import { attachFingerprintFields } from 'src/main/native-chat/agent-session-wire/structured-agent-session-attach'
# const params = {
#   location: { executionHostId: 'local', wslDistro: null,
#               workspaceId: '<worktree workspace id>', workspaceKind: 'folder' },
#   provider: 'external', agent: 'external',
#   accountHome: { variable: 'EXTERNAL_BRIDGE_DIR', path: '<workspace root>' },
#   runtimeKind: 'native',
# }
# const envelope = { sessionId: 'external_<uuid>', clientOperationId: '<uuid>',
#   expectedRuntimeFence: null, payloadFingerprint: '' }
# envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
#   method: 'agentSession.attach', sessionId: envelope.sessionId,
#   fields: attachFingerprintFields({ ...params, envelope }) })
# await rpc('agentSession.ensure', { ...params, envelope })
# ```
# Dispatch from Native Chat, observe streamed fake output
# ("mock response for: …") in the normal chat bubble; kill + restart the mock
# independently and confirm fail-closed fallback + explicit re-acquire.
````

The inline-mock test in `external-structured-session-adapter.test.ts`
proves the same path headlessly: real `BridgeHost` + live `node -e` mock →
`acquire` → `dispatch(accepted)` → `session_event` stream → journal sink
appends carrying normal Native Chat blocks → `settled` re-enables input.

## Wiring sketch

```ts
import { ExternalStructuredSessionAdapter } from './external/external-structured-session-adapter.js'

const adapter = new ExternalStructuredSessionAdapter({
  resolveWorkspacePath: (workspaceId) => resolveWorkspace(workspaceId),
  readProcessStartTime
})
// Dev gate: only when --enable-external-structured-bridge + ORCA_PI_BRIDGE_COMMAND
if (adapter.supportsCreate(location, 'external')) {
  const { sessionId } = { sessionId: orcaSessionId }
  await adapter.acquire({ identity, fence, spawnToken, events: sink })
  const outcome = await adapter.dispatch({ sessionId, clientMessageId, body, fence })
  // accepted → provider owns turn (providerIdentity names it)
  // rejected → toast + offer Pi TUI
  // unknown → reconcile via history; NEVER auto-resend
  disposables.push(() => adapter.disposeSession(sessionId))
}
```

Missing/incompatible bridge → `acquire` throws `AgentSessionPreSpawnError`
→ caller keeps the ordinary Pi TUI path untouched + one-line notice.
Packaged Orca never requires the bridge.

## Failure semantics (fail closed)

| Situation                                                       | Adapter behavior                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Flag absent / command empty                                     | `supportsCreate=false`; `acquire` throws refusal                                                                                                                         |
| Missing binary / spawn error / hello timeout / version mismatch | `acquire` throws `PreSpawn` → TUI fallback, helper torn down                                                                                                             |
| Dispatch with no live session                                   | `{rejected: bridge-unavailable}` → TUI fallback                                                                                                                          |
| Provider `rejected`                                             | `{rejected}` with reason surfaced                                                                                                                                        |
| Timeout / malformed ack / exit racing send                      | `{unknown}` — reconcile via history, never auto-resend                                                                                                                   |
| Image attachments (SNC1.6)                                      | `image-ref` → bridge `images[]` opaque base64; URL refs / unreadable / oversize → `{rejected}` actionable; provider `model-rejects-images` → `{rejected}` + TUI fallback |
| Unknown option key / bad queueMode                              | throws — wire records restore failure                                                                                                                                    |
| `close`/`dispose`                                               | release + bounded dispose; `closeAll` joins Orca teardown                                                                                                                |

## Temporary dev mapping (must go before upstream)

- Provider handle is first-class `external` (`external-structured-owner-identity.ts`)
  with `EXTERNAL_BRIDGE_DIR`-pinned account home; journal streaming items use
  `legacy`/`external` identities (bridge-era records with no provider-stable
  identity) — honest about provenance.
- `readCommands` returns `undefined` (client stays on its catalog until
  SNC1.8 proves Pi commands); `historyFilePath` returns `null`.
- SNC1.6 done: structured images (attachment `image-ref` → `images[]`,
  text-only history, `model-rejects-images` refusal), model/thinking
  current via `get_session` + set via `setOptions` (exact qualified
  `provider/modelId`, `AMBIGUOUS_MODEL`/`UNKNOWN_MODEL`/
  `UNKNOWN_THINKING_LEVEL` fail closed, no fuzzy), prompts via normal
  affordances with exactly-once `answerPrompt` (stale → `UNKNOWN_REQUEST`).
- SNC1.8 follow-up: full catalog seam (`models:[]` until bridge v1 gains a
  provider-neutral catalog response; never claim list-complete without it).
- Rewind, compact, background tasks are unimplemented (optional surface);
  the wire degrades gracefully.
- `agentSession.create` worktree-intent + tab publication + UI pickers stay
  claude/codex-only; the seam's entry point is client-supplied-location
  `agentSession.ensure`/attach. TUI↔Chat handoff of external sessions is
  out of scope (SNC1.9 owns handoff).

## Upstream strategy

Keep the upstream PR minimal and provider-neutral: three vendored files +
adapter + config + teardown + mock E2E test. No Pi imports, no
credential/env plumbing over the bridge (only `PATH` + spawn token via
process env, never over JSONL), no remote/mobile claims, no manifest
capability widening.
