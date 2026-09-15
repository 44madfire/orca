import { runProcess } from '../../shared/child-process/run-process'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { serviceExecutionError } from './plugin-service-execution-errors'
import type { ServiceWorktreeRuntime } from './plugin-service-worktree-runtime'
import {
  terminateClaimedSidecar,
  type ClaimedSidecarProcess
} from './plugin-service-process-ownership'
import type { SidecarJobBinder } from './plugin-service-windows-job'
import { buildGuestSweepArgv, parseGuestSweepOutput } from './plugin-service-wsl-supervisor'
import {
  detachGenerationStreams,
  failGenerationPending,
  type Generation,
  type SidecarLifecycleDeps
} from './plugin-service-sidecar-generation'

// A WSL guest that outlived its wrapper. The wrapper's death is not the
// guest's: the VM outlives wsl.exe, so the nonce + in-distro pids must be
// preserved and swept with proof before the scope forgets them.
export type OrphanedGuest = {
  distro: string
  nonce: string
}

export type GenerationTeardown = {
  serviceId: string
  runtime: ServiceWorktreeRuntime
  deps: SidecarLifecycleDeps
  isCurrent: (gen: Generation | null) => boolean
  clearCurrent: (gen: Generation) => void
  noteOrphan: (orphan: OrphanedGuest) => void
}

// Tracks WSL guests that outlived their wrapper. Sweeps are idempotent
// (verify-then-kill), so a record is kept until a sweep proves it gone.
export type OrphanTracker = {
  readonly orphans: OrphanedGuest[]
  note: (orphan: OrphanedGuest) => void
  sweep: (deps: SidecarLifecycleDeps, serviceId: string) => Promise<void>
}

export function createOrphanTracker(): OrphanTracker {
  const orphans: OrphanedGuest[] = []
  return {
    orphans,
    note: (orphan) => {
      if (!orphans.some((existing) => existing.nonce === orphan.nonce)) {
        orphans.push(orphan)
      }
    },
    sweep: async (deps, serviceId) => {
      if (orphans.length === 0) {
        return
      }
      const remaining = await sweepOrphanedGuestList(deps, orphans)
      orphans.length = 0
      orphans.push(...remaining)
      if (remaining.length > 0) {
        throw serviceExecutionError('teardown-unverified', serviceId, 'guest processes may survive')
      }
    }
  }
}

export function createGenerationTeardown(
  serviceId: string,
  runtime: ServiceWorktreeRuntime,
  deps: SidecarLifecycleDeps,
  isCurrent: (gen: Generation | null) => boolean,
  clearCurrent: (gen: Generation) => void,
  noteOrphan: (orphan: OrphanedGuest) => void
): GenerationTeardown {
  return { serviceId, runtime, deps, isCurrent, clearCurrent, noteOrphan }
}

const GUEST_SWEEP_TIMEOUT_MS = 12_000

// End one generation: fail its callers, close stdin, sweep the guest first
// (WSL), then tear the wrapper down through ownership-verified teardown. Any
// step that cannot prove the tree gone throws teardown-unverified instead of
// claiming success — the caller (dispose-all) reports it loudly.
export async function stopSidecarGeneration(
  ctx: GenerationTeardown,
  gen: Generation | null
): Promise<void> {
  // A failed generation never holds a live child (crash accounting clears
  // it), so only live states need teardown below.
  if (!gen || gen.state === 'gone' || (gen.state === 'failed' && !gen.child)) {
    if (gen) {
      gen.state = 'gone'
    }
    if (gen && ctx.isCurrent(gen)) {
      ctx.clearCurrent(gen)
    }
    return
  }
  gen.state = 'stopping'
  failGenerationPending(
    gen,
    serviceExecutionError('cancelled', ctx.serviceId, 'sidecar is stopping'),
    true
  )
  gen.readyReject(serviceExecutionError('cancelled', ctx.serviceId, 'sidecar is stopping'))
  try {
    gen.child?.stdin?.end()
  } catch {
    /* already gone */
  }
  // A spawned wrapper may own guest life the host never observed (no
  // READY yet, or a helper outliving its leader), so the sweep always runs
  // when a wrapper exists and the script arbitrates quiescence by lease.
  if (ctx.runtime.kind === 'wsl' && gen.claim) {
    if (!(await sweepGuestByLease(ctx.deps, guestTarget(ctx, gen)))) {
      // Identity is preserved in the orphan record so a later stop/dispose
      // retries the sweep instead of leaking the guest behind this throw.
      ctx.noteOrphan(guestTarget(ctx, gen))
      markGone(ctx, gen)
      throw serviceExecutionError(
        'teardown-unverified',
        ctx.serviceId,
        'guest processes may survive'
      )
    }
  }
  if (gen.claim) {
    const verdict = await terminateClaimedSidecar(gen.claim, gen.child, gen.id, {
      ...ctx.deps.ownership,
      jobBinder: ctx.deps.jobBinder ?? null
    })
    releaseJob(ctx.deps.jobBinder, gen.claim, gen.id)
    detachGenerationStreams(gen)
    if (verdict === 'unverifiable') {
      // Keep child + claim + current: a retrying dispose re-attempts this
      // exact teardown instead of succeeding over a possibly-live tree.
      gen.state = 'failed'
      throw serviceExecutionError('teardown-unverified', ctx.serviceId, 'sidecar may survive')
    }
    gen.child = null
    markGone(ctx, gen)
    return
  }
  killGenerationRoot(gen)
  detachGenerationStreams(gen)
  markGone(ctx, gen)
}

function guestTarget(ctx: GenerationTeardown, gen: Generation): OrphanedGuest {
  return {
    distro: ctx.runtime.kind === 'wsl' ? ctx.runtime.distro : '',
    nonce: gen.nonce
  }
}

// Sweep previously orphaned guests (wrapper lost before teardown). Returns
// the unswept remainder; a non-empty remainder is teardown-unverified.
export async function sweepOrphanedGuestList(
  deps: SidecarLifecycleDeps,
  orphans: readonly OrphanedGuest[]
): Promise<OrphanedGuest[]> {
  const remaining: OrphanedGuest[] = []
  for (const orphan of orphans) {
    const swept = await sweepGuestByLease(deps, orphan).catch(() => false)
    if (!swept) {
      remaining.push(orphan)
    }
  }
  return remaining
}

// Lease sweep: the host never decides liveness from its own probes here.
// Only the in-guest scan can prove quiescence (a dead leader never implies
// a dead tree), so every WSL teardown with a spawned wrapper runs exactly
// one sweep invocation and lets the script arbitrate.
async function sweepGuestByLease(
  deps: SidecarLifecycleDeps,
  target: OrphanedGuest
): Promise<boolean> {
  if (!target.distro) {
    return true
  }
  const sweep = deps.sweepGuestImpl ?? defaultSweepGuest
  try {
    return await sweep(target.distro, buildGuestSweepArgv(target.nonce))
  } catch {
    return false
  }
}

function markGone(ctx: GenerationTeardown, gen: Generation): void {
  gen.state = 'gone'
  if (ctx.isCurrent(gen)) {
    ctx.clearCurrent(gen)
  }
}

function killGenerationRoot(gen: Generation): void {
  try {
    gen.child?.kill()
  } catch {
    /* already gone */
  }
}

async function defaultSweepGuest(distro: string, argv: readonly string[]): Promise<boolean> {
  try {
    const result = await runProcess({
      program: 'wsl.exe',
      args: buildWslExecArgs(distro, [...argv]),
      timeoutMs: GUEST_SWEEP_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0) {
      return false
    }
    return parseGuestSweepOutput(result.stdout).done
  } catch {
    return false
  }
}

function releaseJob(
  binder: SidecarJobBinder | null | undefined,
  claim: ClaimedSidecarProcess,
  generation: number
): void {
  if (binder?.available && claim.job && claim.job.generation === generation) {
    binder.release(claim.job)
    claim.job = null
  }
}
