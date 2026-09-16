# Plugin Panel → Own Worker RPC Design

**Date:** 2026-09-16

**Status:** Approved design for the `44madfire/orca` fork. Intended to remain generic enough to upstream to `stablyai/orca`.

## Goal

Add one narrow plugin-platform primitive to Orca: a sandboxed plugin panel can make a structured request to **its own plugin worker**, and Orca routes that request through the existing panel-session and worker-supervision machinery while attaching trusted host-owned context for the worktree that was active when the request was admitted.

This feature exists to support rich plugin-owned application UIs without adding plugin-specific policy to Orca.

## Decision

Implement a private self-RPC surface separate from public/user-facing plugin commands and separate from Orca Host API calls:

```text
sandboxed plugin panel
        |
        | orca-panel-rpc { requestId, method, params }
        v
renderer panel bridge host
        |
        | session token added by Orca
        v
main PluginPanelController
        |
        | resolve session -> pluginKey + panelId
        | snapshot trusted worktree context
        v
PluginService.invokePanelRpc(...)
        |
        | ensure existing plugin worker
        v
plugin worker IPC invokeRpc/rpcResult
        |
        v
orca.rpc.register(method, handler)
```

The panel never chooses a plugin identity, panel identity, filesystem/worktree scope, or capability grant.

## Current Orca primitives to reuse

The design deliberately reuses existing infrastructure instead of adding a new plugin-service/subprocess framework:

- `PluginPanelController` already issues and resolves session tokens bound to `pluginKey`, `panelId`, plugin root, and manifest revision.
- The renderer already validates the sending iframe `contentWindow` and relays panel messages through preload/main.
- `PluginService` already re-checks plugin approval and can ensure/start the correct worker.
- `PluginWorkerController` / `plugin-host-process.ts` already supervise the forked worker, bound invocations, timeouts, exit, and shutdown.
- `PluginWorkerOrcaApi` already exposes `commands.register`, `events.on`, `host.call`, `grantedCapabilities`, and `log`.
- `PluginRuntimeDelegate.resolveActiveWorktreeContext()` already exposes host-internal `{ worktreeId, path, branch, displayName }`; the public `workspace.readContext` projection intentionally strips the path.
- The existing panel bridge already enforces CSP, message-size/rate budgets, session liveness, and main-process authority.

## Non-goals

This design MUST NOT introduce:

- Pi/orca-pi-specific method names, services, schemas, profile concepts, GitHub behavior, or filesystem rules;
- cross-plugin RPC;
- panel-selected target plugin IDs;
- a generic `process:exec` capability;
- generic filesystem access through the Orca Host API;
- a service registry unrelated to a plugin's own worker;
- streaming RPC, subscriptions, worker→panel unsolicited push, or cancellation in v1;
- manifest-declared public RPC methods;
- a second plugin worker lifecycle;
- replacement of existing plugin commands or Host API methods.

## Public worker API

Extend the API passed to a plugin's `activate(orca)` entry with a private RPC registrar:

```ts
type PluginPanelRpcContext = {
  panelId: string
  worktree: {
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null
  grantedCapabilities: readonly PluginCapabilityKind[]
}

type PluginWorkerOrcaApi = {
  commands: { register(...) }
  events: { on(...) }
  host: { call(...) }
  rpc: {
    register(
      method: string,
      handler: (params: unknown, context: PluginPanelRpcContext) => unknown | Promise<unknown>
    ): void
  }
  grantedCapabilities: readonly string[]
  log(message: string): void
}
```

### Method naming and registration

- Reuse `pluginCommandIdSchema` grammar unless code inspection shows a more suitable existing identifier schema.
- Keep RPC methods private to the worker; do **not** add `contributes.rpc` to `orca-plugin.json`.
- The worker reports registered RPC methods in its ready handshake so main can reject unknown methods before dispatch.
- Cap the registered method count using the existing command-count order of magnitude (prefer the existing `PLUGIN_COMMAND_LIMIT` unless a separate constant materially improves clarity).
- Duplicate `rpc.register()` of the same method MUST fail deterministically during activation rather than silently overwrite a handler.

## Worker protocol

Extend the existing validated parent↔child plugin-host protocol with a sibling to `invokeCommand`/`commandResult`:

```ts
// parent -> child
{
  type: 'invokeRpc'
  callId: number
  method: string
  params?: JsonValue
  context: PluginPanelRpcContext
}

// child -> parent
{
  type: 'rpcResult'
  callId: number
  ok: true
  value: JsonValue
}

// or
{
  type: 'rpcResult'
  callId: number
  ok: false
  error: string
}
```

Requirements:

- Zod-validate both directions exactly like the existing worker protocol.
- Reuse the existing invocation timeout class (30 s today) unless a current constant already models generic worker calls.
- Pending RPC calls MUST be rejected on worker exit/disconnect/shutdown exactly as pending commands are.
- RPC counts as worker activity for idle reaping.
- The public v1 RPC contract is JSON-compatible values only. Do not expose Node's richer structured-clone vocabulary merely because fork serialization supports it.
- Error strings returned across the boundary are bounded using existing plugin error/log bounds.

The worker ready message becomes conceptually:

```ts
{
  type: 'ready'
  commands: string[]
  rpcMethods: string[]
}
```

## Panel protocol

Worker RPC is semantically distinct from Host API panel actions. Keep separate message types rather than pretending worker methods are Host API methods.

Iframe -> renderer:

```ts
{
  type: 'orca-panel-rpc'
  requestId: string
  method: string
  params?: JsonValue
}
```

Renderer/main response -> iframe:

```ts
{
  type: 'orca-panel-rpc-result'
  requestId: string
  ok: true
  value: JsonValue
}
```

or:

```ts
{
  type: 'orca-panel-rpc-result'
  requestId: string
  ok: false
  errorCode:
    | 'invalid_request'
    | 'unknown_method'
    | 'rate_limited'
    | 'unavailable'
    | 'action_failed'
  error: string
}
```

### Authority rules

The iframe payload MUST NOT accept:

- `pluginKey`;
- target worker/plugin identifiers;
- `panelId` as authority;
- worktree ID/path;
- capability grants;
- session token.

The renderer adds the current host-issued session token when relaying through preload. Main resolves that token to the authoritative plugin/panel binding.

## Main-process dispatch

Add a session-bound RPC entry in `PluginPanelController`, conceptually:

```ts
executeRpc(ownerKey: string, call: unknown): Promise<PluginPanelRpcOutcome>
```

Required order:

1. Parse/extract the host-added session token.
2. Resolve it through `PluginPanelSessions`.
3. Apply the same owner/session freshness rules used by panel actions.
4. Re-resolve the approved plugin and confirm root/manifest/panel identity still matches the binding.
5. Apply the existing panel admission/rate budget to the request. RPC must not create a bypass around panel message budgets.
6. Validate `method` and JSON params.
7. Ask `PluginService` to invoke the RPC using only the plugin identity derived from the session.
8. Return a bounded structured outcome.

Add a `PluginService.invokePanelRpc(pluginKey, panelId, method, params)` path that:

1. re-checks plugin runtime approval;
2. snapshots current granted capabilities;
3. snapshots trusted active-worktree context before worker dispatch;
4. filters context according to capabilities;
5. ensures the current approved plugin worker;
6. verifies `method` is in the worker's registered `rpcMethods`;
7. invokes the worker with the immutable context snapshot.

## Trusted worktree context

The reason this design lives in Orca rather than being a raw iframe→worker pipe is trusted scope.

### Snapshot semantics

At RPC admission time, main snapshots the active worktree:

```ts
const current = await runtime.resolveActiveWorktreeContext()
```

The snapshot is attached to that invocation and must not be re-resolved after asynchronous dispatch begins.

Therefore:

```text
panel submits while worktree A is active
        ↓
Orca snapshots A
        ↓
user focuses worktree B
        ↓
worker still receives A for that request
```

This is a required race-safety invariant.

### Capability filtering

`worktree.path` is host-owned privileged workspace information. Do not expose it unless the plugin currently holds `workspace:read`.

Required v1 rule:

```text
workspace:read granted -> context.worktree = trusted snapshot
workspace:read absent  -> context.worktree = null
```

The `grantedCapabilities` array on the RPC context is a fresh per-request snapshot. The worker's activation-time `orca.grantedCapabilities` remains informational and MUST NOT be treated as authoritative for a delayed RPC after consent changes.

No new capability is added solely for RPC: self-RPC is transport between two components of the same already-approved plugin, not a host resource. Resource data injected into the context remains governed by its existing capability.

## Security invariants

1. **Self-only:** a panel can reach only the worker belonging to its session-bound plugin.
2. **No caller-supplied authority:** plugin identity, panel identity, worktree scope, and grants come from Orca.
3. **Revocation-aware:** disabled/uninstalled/unapproved plugins and revoked panel sessions fail before worker dispatch.
4. **Focus-race safe:** worktree context is captured before asynchronous invocation and stays immutable.
5. **Capability-filtered scope:** workspace path never appears without `workspace:read`.
6. **Existing sandbox unchanged:** never add `allow-same-origin`; plugin CSP/network/navigation restrictions remain unchanged.
7. **Existing admission budgets reused:** panel RPC must not create an unlimited second lane.
8. **Bounded data:** request/result/error sizes remain bounded; JSON-only v1.
9. **No renderer authority:** renderer/preload transport does not decide plugin approval or capability access.
10. **No cross-plugin addressing now or implicitly later:** adding cross-plugin RPC would require a separate design and consent model.

## Error model

Host-level errors are transport/lifecycle errors only:

- `invalid_request`: malformed request/session envelope;
- `unknown_method`: worker did not register the method;
- `rate_limited`: existing panel admission budget refused the call;
- `unavailable`: plugin disabled/unapproved, panel stale, no worker, worker exited, or runtime/worktree service unavailable where required for context acquisition;
- `action_failed`: registered handler threw/rejected.

Domain errors belong inside the plugin's returned JSON contract. Orca must not understand plugin-specific error codes.

## Compatibility

- Existing panels using `orca-panel-action` continue unchanged.
- Existing worker commands continue unchanged.
- Existing plugins that do not reference `orca.rpc` continue unchanged.
- Older Orca builds simply lack the RPC transport; plugins must feature-detect and degrade on their side.
- Do not change `pluginApi` major. This is an additive experimental API while pluginApi 1 is not frozen.
- Desktop main and headless/serve/runtime RPC paths must enforce equivalent session binding and self-only semantics. If one transport cannot safely support the feature, it must fail closed rather than expose a weaker variant.

## Expected Orca code areas

Primary files to inspect/modify:

```text
src/shared/plugins/plugin-panel-bridge.ts
src/shared/plugins/plugin-host-protocol.ts
src/main/plugins/plugin-host-runtime.ts
src/main/plugins/plugin-host-process.ts
src/main/plugins/plugin-worker-controller.ts
src/main/plugins/plugin-panel-controller.ts
src/main/plugins/plugin-service.ts
src/main/plugins/plugin-host-service-bindings.ts
src/main/ipc/plugins.ts
src/main/runtime/rpc/methods/plugins.ts
src/preload/api/plugin-host-api.ts
src/renderer/src/components/right-sidebar/plugin-panel-bridge-host.ts
src/renderer/src/components/right-sidebar/PluginPanel.tsx
examples/plugins/hello-orca/*
```

Follow current code structure rather than forcing all changes into these exact files. New focused shared modules are preferable when they keep action-RPC schemas or context construction independently testable.

## PR decomposition

### ORPC-1 — Worker-private RPC registration and fork protocol

Deliver the worker API and parent↔child request/response machinery without panel exposure yet.

Must prove:

- registration and duplicate rejection;
- ready handshake method discovery;
- invoke/result success and failure;
- unknown method refusal;
- timeout/exit/disconnect cleanup;
- JSON schema enforcement;
- worker activity/idle-reap accounting;
- commands/events/host.call regressions remain green.

### ORPC-2 — Session-bound panel→own-worker relay

Add iframe/renderer/preload/main transport and route through `PluginPanelController` to `PluginService.invokePanelRpc`.

Must prove:

- correct iframe source only;
- host adds session token;
- no panel-supplied plugin target;
- stale/rotated/revoked session refusal;
- panel A cannot call plugin B;
- method/result/error correlation under concurrent calls;
- existing `orca-panel-action` path unchanged;
- existing message/admission limits cover RPC.

### ORPC-3 — Trusted per-request worktree context and consent-race hardening

Attach immutable worktree context/grant snapshots to each RPC.

Must prove:

- path comes from `resolveActiveWorktreeContext`, never panel input;
- `workspace:read` gate controls whether context is present;
- grant revocation before request removes context;
- focus switch after admission cannot retarget a delayed request;
- stale session/worker replacement cannot reuse old context;
- Windows/WSL-style path strings are transported losslessly without normalization guesses in Orca;
- desktop and headless/runtime paths enforce the same authority rules.

### ORPC-4 — Generic example, conformance, docs, compatibility hardening

Extend `hello-orca` with one private RPC and add end-to-end/conformance coverage.

Must prove through the real stack:

```text
panel -> renderer bridge -> preload -> main panel session ->
PluginService -> worker fork -> rpc handler -> response -> panel
```

Also verify no `pluginKey`, path, or grants are accepted from the iframe, and document the API as generic plugin infrastructure.

## Required test philosophy

Every PR must be test-first at its boundary. Tests should prefer behavioral authority checks over brittle source-text assertions.

Critical regression matrix across the epic:

- malformed panel RPC rejected;
- oversized panel RPC rejected by existing budget;
- rate-limit exhaustion cannot be bypassed via RPC;
- spoofed plugin identity impossible/rejected;
- wrong iframe window ignored;
- stale session token rejected;
- disabled/uninstalled plugin rejected;
- worker crash rejects in-flight request;
- unknown RPC method rejected without handler execution;
- two concurrent RPCs correlate to the correct results;
- focus switch cannot retarget trusted scope;
- capability revoke changes the next invocation immediately;
- existing commands still invoke normally;
- existing Host API panel actions still invoke normally;
- existing events still deliver normally;
- worker shutdown/idle reap remains correct;
- desktop and runtime/serve conformance remains aligned.

## Acceptance criteria

- A generic sample plugin can register a private RPC handler in its worker and invoke it from its own sandboxed panel.
- The panel cannot select another plugin/worker.
- The worker receives host-owned, per-request, capability-filtered worktree context.
- Context is captured race-safely at request admission.
- Existing panel actions/commands/events remain backwards compatible.
- No plugin-specific policy is added to Orca.
- The API is small enough to propose upstream without carrying Orca-Pi concepts.
