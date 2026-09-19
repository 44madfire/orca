# Hello Orca sample plugin

Sample plugin combining a sandboxed panel, a worker command, event
subscriptions, and one private panel→worker RPC.

## Private worker RPC (`orca.rpc.register`)

The worker registers a private method callable only from this plugin's own
panel:

```js
orca.rpc.register('hello.getStatus', async (params, context) => ({
  echo: params ?? null,
  panelId: context.panelId,
  worktree: context.worktree
    ? { branch: context.worktree.branch, displayName: context.worktree.displayName }
    : null,
}))
```

- RPC methods are private implementation details, not manifest
  contributions. There is no `contributes.rpc` in `orca-plugin.json`.
- Only this plugin's own panel can address them. The panel supplies only
  `method`/`params`; the host resolves plugin, panel, and worktree scope
  from the panel session.
- Params/results are JSON-compatible and bounded.
- `context` is host-owned and per-request: `{ panelId, worktree, grantedCapabilities }`.
- `workspace:read` governs `context.worktree`. Without it the worker sees
  `worktree: null`. The panel output shows branch/displayName only and
  never the filesystem path; path transport is verified by the host test
  harness.
- Current grants are snapshotted per request. The activation-time
  `orca.grantedCapabilities` array is informational and is not authoritative
  for a delayed RPC after consent changes.
- v1 has no streaming, push, cross-plugin invocation, or cancellation.

## Panel-side usage

The panel posts a structured message to its host frame:

```js
window.parent.postMessage(
  { type: 'orca-panel-rpc', requestId: 'rpc-1', method: 'hello.getStatus', params: { hello: 'panel' } },
  '*',
)
```

The host replies with `orca-panel-rpc-result` carrying the same
`requestId`. See `panel.html` (`callRpc`, `orca-panel-rpc-result` listener,
`#rpc` button) for the full pattern.

## Security note

The panel cannot select a plugin or worktree target. Renderer and preload
code are transport only: they attach the host-issued session token, and
main re-resolves the session, re-checks approval, snapshots trusted
worktree context, filters it by current capabilities, and dispatches to the
session-bound worker. Never add `allow-same-origin` to the panel frame.
