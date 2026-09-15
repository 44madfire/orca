import { runProcess } from '../../shared/child-process/run-process'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { serviceExecutionError } from './plugin-service-execution-errors'
import type { ServiceWorktreeRuntime } from './plugin-service-worktree-runtime'
import {
  terminateClaimedSidecar,
  type ClaimedSidecarProcess
} from './plugin-service-process-ownership'
import type { SidecarJobBinder } from './plugin-service-windows-job'
import { buildGuestSweepScript, parseGuestSweepOutput } from './plugin-service-wsl-supervisor'
import {
  detachGenerationStreams,
  failGenerationPending,
  type Generation,
  type SidecarLifecycleDeps
} from './plugin-service-sidecar-generation'

export type GenerationTeardown = {
  serviceId: string
  runtime: ServiceWorktreeRuntime
  deps: SidecarLifecycleDeps
  isCurrent: (gen: Generation | null) => boolean
  clearCurrent: (gen: Generation) => void
}

export function createGenerationTeardown(
  serviceId: string,
  runtime: ServiceWorktreeRuntime,
  deps: SidecarLifecycleDeps,
  isCurrent: (gen: Generation | null) => boolean,
  clearCurrent: (gen: Generation) => void
): GenerationTeardown {
  return { serviceId, runtime, deps, isCurrent, clearCurrent }
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
  if (
    ctx.runtime.kind === 'wsl' &&
    (gen.guestSupervisorPid !== null || gen.guestChildPid !== null)
  ) {
    if (!(await sweepGuest(ctx, gen))) {
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
    gen.child = null
    markGone(ctx, gen)
    if (verdict === 'unverifiable') {
      throw serviceExecutionError('teardown-unverified', ctx.serviceId, 'sidecar may survive')
    }
    return
  }
  killGenerationRoot(gen)
  detachGenerationStreams(gen)
  markGone(ctx, gen)
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

async function sweepGuest(ctx: GenerationTeardown, gen: Generation): Promise<boolean> {
  const distro = ctx.runtime.kind === 'wsl' ? ctx.runtime.distro : null
  if (!distro || gen.guestSupervisorPid === null) {
    return true
  }
  const script = buildGuestSweepScript(gen.guestSupervisorPid, gen.guestChildPid)
  const sweep = ctx.deps.sweepGuestImpl ?? defaultSweepGuest
  try {
    return await sweep(distro, script)
  } catch {
    return false
  }
}

async function defaultSweepGuest(distro: string, script: string): Promise<boolean> {
  try {
    const result = await runProcess({
      program: 'wsl.exe',
      args: buildWslExecArgs(distro, ['/bin/sh', '-c', script]),
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
