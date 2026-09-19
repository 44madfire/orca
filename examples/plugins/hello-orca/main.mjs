// Sample Orca plugin worker entry. Runs inside the out-of-process plugin
// worker (plain Node, no Electron), forked lazily on the first trigger. The
// default export receives the `orca` API: command registration, event
// handlers, the capability-gated host API, and private panel RPC.
//
// orca.rpc.register(method, handler) exposes a private method callable only
// from this plugin's own sandboxed panel. RPC methods are NOT manifest
// contributions; only the owning panel can address them, params/results are
// JSON-compatible and bounded, and the per-request context carries
// host-owned worktree scope (workspace:read governs the worktree field) plus
// a fresh grant snapshot. v1 has no streaming, push, cross-plugin calls, or
// cancellation.
export default function activate(orca) {
  orca.commands.register('hello-ping', async (args) => {
    const stored = await orca.host.call('storage.get', { key: 'pings' })
    const count = (typeof stored?.value === 'number' ? stored.value : 0) + 1
    await orca.host.call('storage.set', { key: 'pings', value: count })
    return { pong: true, count, args: args ?? null }
  })

  orca.events.on('worktree.created', async (payload) => {
    orca.log(`worktree created: ${payload.worktreeId} at ${payload.path}`)
    await orca.host.call('notifications.show', {
      title: 'Worktree created',
      body: payload.path
    })
  })

  orca.events.on('agent.status.changed', (payload) => {
    orca.log(`agent status: ${payload.state} in ${payload.worktreeId ?? 'unknown worktree'}`)
  })

  // Private panel RPC for the plugin's own panel. The response deliberately
  // echoes only branch/displayName, never the filesystem path: path transport
  // is verified by the host test harness, not demonstrated in panel output.
  if (orca.rpc) {
    orca.rpc.register('hello.getStatus', async (params, context) => ({
      echo: params ?? null,
      panelId: context.panelId,
      worktree: context.worktree
        ? {
            branch: context.worktree.branch,
            displayName: context.worktree.displayName
          }
        : null
    }))
  }
}
