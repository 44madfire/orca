import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
import {
  captureTerminalPaneRecoveryGeneration,
  requestTerminalPaneRecovery,
  type TerminalPaneRecoveryReason
} from '../terminal-pane-recovery'
import {
  TRANSPORT_CONNECT_SETTLE_GRACE_MS,
  pendingSpawnByPaneKey,
  pendingSpawnGenerationByPaneKey
} from './pty-connect-limits'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Why a module-level set: a promise is already a unique identity, so arming from
// both the fresh spawn and a remount's pending-spawn adoption cannot double-time it.
const spawnSettlementTimedPromises = new WeakSet<Promise<unknown>>()
// Why keyed on the spawn and not on the arming call: a remount adopts a pending
// spawn it did not start, so a flag passed by the caller would be lost exactly
// when the arming pane was disposed before it could arm — the one case where the
// adopter's own arming is what runs.
const resumeShapedSpawns = new WeakSet<Promise<unknown>>()

function remountUnboundPane(
  session: ConnectPanePtySession,
  reason: TerminalPaneRecoveryReason,
  anomaly: string
): void {
  warnTerminalLifecycleAnomaly(anomaly, {
    tabId: session.deps.tabId,
    worktreeId: session.deps.worktreeId,
    leafId: session.deps.restoredLeafId ?? session.pane.leafId,
    paneId: session.pane.id,
    ptyId: null
  })
  void requestTerminalPaneRecovery({
    tabId: session.deps.tabId,
    ptyId: null,
    reason,
    terminalRecoveryGeneration: session.terminalRecoveryGeneration,
    terminalRecoveryInstanceId: session.terminalRecoveryInstance.id
  })
}

/** Settle a spawn that resolved without a PTY id, remounting the pane when
 *  nothing else owns its recovery.
 *
 *  Why this is not self-correcting: the pane stays mounted with no transport
 *  binding, so `registerData` never runs. Main keeps pushing pty:data for the
 *  old id, the dispatcher finds no handler and buffers it in the pre-handler
 *  buffer — which claims no delivery credit, so the bytes are ACKed anyway and
 *  main's flow control reads healthy while the pane displays its last frame
 *  forever. The visibility reconciler skips unbound panes, so nothing else
 *  rebinds one. A remount reattaches over the still-live PTY and drains the
 *  buffer.
 *
 *  A direct-SSH lease runs its own retry ledger, so it keeps ownership here and
 *  a second remount never races it. */
export function settleSpawnThatLeftPaneUnbound(session: ConnectPanePtySession): void {
  // Read before settling: the settle clears the lease this branch tests.
  const directSshRetryOwnsRecovery = Boolean(session.directSshRetryAttempt)
  session.settleDirectSshPaneRetryAttempt(session.directSshRetryAttempt, 'failed')
  if (directSshRetryOwnsRecovery) {
    return
  }
  remountUnboundPane(session, 'spawn-left-pane-unbound', 'fresh spawn left the pane unbound')
}

/** Own both outcomes of one spawn: it settles with no PTY id, or it never
 *  settles at all. Both leave the pane mounted and unbound, so they share the
 *  remount seam and are kept together rather than split across the caller. */
export function observeSpawnSettlement(
  session: ConnectPanePtySession,
  trackedPromise: Promise<string | null>,
  options: { resumesProviderSession?: boolean } = {}
): void {
  // Recorded before arming, so a pane disposed too early to arm still hands the
  // flag to whichever remount adopts this spawn.
  if (options.resumesProviderSession === true) {
    resumeShapedSpawns.add(trackedPromise)
  }
  armSpawnSettlementWatchdog(session, trackedPromise)
  void trackedPromise.then((spawnedPtyId) => {
    if (spawnedPtyId) {
      return
    }
    // Deferred: let a concurrent sibling spawn claim the pane key first.
    queueMicrotask(() => {
      if (
        session.disposed ||
        session.transport.getPtyId() ||
        pendingSpawnByPaneKey.has(session.pendingSpawnKey)
      ) {
        return
      }
      settleSpawnThatLeftPaneUnbound(session)
    })
  })
}

/** Bound how long a pane waits on a spawn that may never settle.
 *
 *  Why not a timeout on the invoke itself: rejecting in the renderer cannot
 *  cancel main's spawn, so a slow-but-alive one would be respawned and the late
 *  PTY orphaned. This times out the pane's *waiting* instead; a late settlement
 *  is already retired by the existing spawn-retirement path.
 *
 *  Unpinning is unconditional because a hung invoke otherwise strands the
 *  pane-key entry forever, which also freezes any remount that adopts it. */
export function armSpawnSettlementWatchdog(
  session: ConnectPanePtySession,
  trackedPromise: Promise<string | null>
): void {
  if (session.disposed || spawnSettlementTimedPromises.has(trackedPromise)) {
    return
  }
  spawnSettlementTimedPromises.add(trackedPromise)
  const { pendingSpawnKey } = session
  const tabId = session.deps.tabId
  const timer = setTimeout(() => {
    if (pendingSpawnByPaneKey.get(pendingSpawnKey) === trackedPromise) {
      pendingSpawnByPaneKey.delete(pendingSpawnKey)
      pendingSpawnGenerationByPaneKey.delete(pendingSpawnKey)
    }
    // Something bound meanwhile, or the SSH ledger owns the retry: leave it alone.
    if (session.transport.getPtyId() || session.directSshRetryAttempt) {
      return
    }
    // Why freeze instead of remount: a cold-restore spawn clears its sleeping
    // record only once it settles, and a late one is deliberately not retired
    // (it may own a recycled id). Remounting a hung one would put a SECOND
    // --resume on the same transcript. A stuck pane is recoverable; two agents
    // writing one conversation is not.
    if (resumeShapedSpawns.has(trackedPromise)) {
      warnTerminalLifecycleAnomaly('resume spawn never settled; remount withheld', {
        tabId,
        worktreeId: session.deps.worktreeId,
        leafId: session.deps.restoredLeafId ?? session.pane.leafId,
        paneId: session.pane.id,
        ptyId: null
      })
      return
    }
    if (!session.disposed) {
      remountUnboundPane(session, 'spawn-never-settled', 'spawn never settled; pane left unbound')
      return
    }
    // Arming pane is gone, but an adopter may still be waiting on the pin. No
    // instance id: this request belongs to the tab, not to a disposed xterm.
    void requestTerminalPaneRecovery({
      tabId,
      ptyId: null,
      reason: 'spawn-never-settled',
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration(tabId)
    })
  }, TRANSPORT_CONNECT_SETTLE_GRACE_MS)
  void trackedPromise.finally(() => clearTimeout(timer)).catch(() => {})
}
