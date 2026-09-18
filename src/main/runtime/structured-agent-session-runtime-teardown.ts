// Teardown half of the structured agent-session runtime.
//
// Split from `structured-agent-session-runtime` (line budget): the ordered shutdown
// both `stopStructuredAgentSessionRuntime` and test isolation share. Pure over the
// installed runtime, so no module slot crosses the split.

import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'

export type InstalledStructuredAgentSessionRuntime = {
  host: Pick<StructuredAgentSessionHost, 'flushAllStreamedEvents'>
  adapter: { closeAll(): Promise<void> }
  /** Resolves after every observed adapter exit has published, and every
   *  recovery callback it raised has settled. */
  waitForRecovery: () => Promise<void>
}

export async function tearDownStructuredAgentSessionRuntime(
  installed: InstalledStructuredAgentSessionRuntime
): Promise<void> {
  // Drain an in-flight recovery before stopping children; recovery may still
  // be writing lifecycle rows or acquiring a replacement child.
  await installed.waitForRecovery()
  const failures: unknown[] = []
  // Host teardown runs FIRST, which inverts the older order. It is what stops this host's
  // provider children now: it evicts each owned session through the adapter, and that eviction
  // only releases the lease once `disposeSession` PROVES the child gone. Closing the adapter
  // first would hand every one of those steps a vacuous receipt from an already-closed router,
  // and would race the attach drain the host runs in the same teardown.
  //
  // Tail rows are protected by eviction's own per-session ordering — stop the child, drain what
  // it already published, settle, then unbind the sink — not by which of the two teardowns runs
  // first. `closeAll` is only a backstop for children eviction never took: an acquisition that
  // failed before the host indexed it, or a session whose eviction was refused and left indexed.
  // A row a child delivers during that backstop close is not captured, and was not captured
  // under the old order either. The drain below keeps a late callback from outliving the runtime.
  try {
    await installed.host.flushAllStreamedEvents()
  } catch (error) {
    failures.push(error)
  }
  try {
    // Backstop for children eviction never took: unindexed acquisitions and refused evictions.
    await installed.adapter.closeAll()
  } catch (error) {
    failures.push(error)
  }
  // A backstop close can still deliver a final exit callback.
  try {
    await installed.waitForRecovery()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'structured agent-session runtime teardown failed')
  }
}
