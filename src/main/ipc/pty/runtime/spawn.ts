import type { AgentSessionClaimedSpawnResult } from '../../../../shared/agent-session-host-authority'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import {
  makePaneSpawnReservationKey,
  paneSpawnReservationsByOwnerKey,
  rejectPaneSpawnReservation,
  reservePaneSpawn,
  resolvePaneSpawnReservation
} from '../pane/spawn-reservation'
import {
  isSleepingAgentResumeBlocked,
  isStablePaneResumeBlocked
} from '../pane/stable-pane-resume-fence'
import { resolveStablePaneOwner } from '../pane/stable-owner'
import { ptySizes } from '../delivery/visibility-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { adoptMaterializedRuntimePtySpawn } from './spawn-early'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { buildRuntimePtySpawnOptions } from './spawn-options'
import { executeRuntimePtySpawn } from './spawn-execute'
import { commitRuntimePtySpawn } from './spawn-commit'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'

function toRuntimeSpawnReply(result: {
  id: string
  exitedBeforeAttach?: true
  reattachUnverifiable?: true
  incarnationId?: string
  wslDistro?: string | null
  stablePaneOwner?: { handle: string; tabId: string; leafId: string }
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
}) {
  return {
    id: result.id,
    ...(result.exitedBeforeAttach ? { exitedBeforeAttach: true as const } : {}),
    ...(result.reattachUnverifiable ? { reattachUnverifiable: true as const } : {}),
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
    ...(typeof result.wslDistro === 'string' ? { wslDistro: result.wslDistro } : {}),
    ...(result.stablePaneOwner ? { stablePaneOwner: result.stablePaneOwner } : {}),
    ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {})
  }
}

function restoreProvisionalPtySize(ctx: ReturnType<typeof createRuntimePtySpawnState>): void {
  if (ctx.sessionId === undefined) {
    return
  }
  const key = ctx.effectiveSessionAppId ?? ctx.sessionId
  if (ctx.hadSessionSizeBeforeAttach && ctx.sessionSizeBeforeAttach) {
    ptySizes.set(key, ctx.sessionSizeBeforeAttach)
  } else {
    ptySizes.delete(key)
  }
}

export async function spawnPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  args: RuntimePtySpawnArgs
) {
  const ctx = createRuntimePtySpawnState(deps, args)
  if (isSleepingAgentResumeBlocked(deps.store, args)) {
    return { id: args.sessionId ?? '', reattachUnverifiable: true as const }
  }
  if (!args.adoptedStablePane) {
    const leafId =
      typeof args.leafId === 'string' && isTerminalLeafId(args.leafId) ? args.leafId : null
    const paneKey =
      typeof args.worktreeId === 'string' &&
      typeof args.tabId === 'string' &&
      isValidTerminalTabId(args.tabId) &&
      args.tabId.length <= 512 &&
      leafId
        ? makePaneKey(args.tabId, leafId)
        : null
    const ownerKey = makePaneSpawnReservationKey(args.worktreeId, args.connectionId, paneKey)
    const existingOwner = paneKey
      ? resolveStablePaneOwner(
          deps.runtime,
          deps.store,
          paneKey,
          args.worktreeId,
          args.connectionId
        )
      : null
    if (
      !existingOwner &&
      isStablePaneResumeBlocked(deps.store, paneKey, args.worktreeId, args.connectionId)
    ) {
      return { id: args.sessionId ?? '', reattachUnverifiable: true as const }
    }
    if (ownerKey && !existingOwner && !paneSpawnReservationsByOwnerKey.has(ownerKey)) {
      ctx.paneSpawnReservationKey = ownerKey
      ctx.paneSpawnReservation = reservePaneSpawn(ownerKey)
    }
  }
  try {
    const materializedOrPromise = adoptMaterializedRuntimePtySpawn(ctx)
    const materialized =
      materializedOrPromise instanceof Promise ? await materializedOrPromise : materializedOrPromise
    if (materialized) {
      return toRuntimeSpawnReply(materialized)
    }
    const earlyAdopt = await prepareRuntimePtySpawn(ctx)
    if (earlyAdopt) {
      return toRuntimeSpawnReply(earlyAdopt)
    }
    const earlyReserved = await buildRuntimePtySpawnOptions(ctx).catch((error: unknown) => {
      restoreProvisionalPtySize(ctx)
      throw error
    })
    if (earlyReserved) {
      return toRuntimeSpawnReply(earlyReserved)
    }
    await executeRuntimePtySpawn(ctx)
    if (ctx.result.exitedBeforeAttach || ctx.result.reattachUnverifiable) {
      restoreProvisionalPtySize(ctx)
      deps.runtime?.cancelPendingPtyRegistration?.(ctx.pendingRegistrationPtyId ?? ctx.result.id)
      ctx.pendingRegistrationPtyId = null
      return toRuntimeSpawnReply(
        resolvePaneSpawnReservation(
          ctx.paneSpawnReservationKey,
          ctx.paneSpawnReservation,
          ctx.result
        )
      )
    }
    return toRuntimeSpawnReply(await commitRuntimePtySpawn(ctx))
  } catch (err) {
    if (ctx.pendingRegistrationPtyId) {
      deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId
      )
      ctx.pendingRegistrationPtyId = null
    }
    // Why: once the reservation is created, any later throw — spawn
    // failure, persist failure, or a post-spawn helper such as
    // registerPty/rememberPaneKeyForPty/track — must settle it. Otherwise
    // it lingers in paneSpawnReservationsByOwnerKey and every future spawn
    // for this pane awaits a promise that never resolves. reject is a
    // no-op once the reservation has already resolved.
    rejectPaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, err)
    throw err
  } finally {
    ctx.releaseWorktreeSpawn?.()
    ctx.finishTerminalInstall()
  }
}
