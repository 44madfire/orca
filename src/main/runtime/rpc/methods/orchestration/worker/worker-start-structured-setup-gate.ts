/**
 * The `wait-for-setup` gate for a structured worker on a worktree this start created.
 *
 * A PTY worker gets the gate for free: agent-first creation sequences the agent's startup command
 * behind the setup runner, so `tui-idle` cannot arrive until setup exits, and the worker start
 * reads the gate's outcome off that wait. A structured session has no startup command to sequence,
 * so without this the worker would take its dispatch preamble while `install` was still running,
 * and the repo's wait-for-setup policy would record no evidence at all.
 *
 * Bounded by the start's own timeout, and deliberately forgiving: a wait that cannot be taken —
 * an in-process hook with no setup terminal, or a setup pty already gone — yields no verdict
 * rather than a failure, because a worker start must not fail on missing evidence.
 */

import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { WorkerEffect, WorkerSetupReceipt } from './worker-topology'

export type StructuredWorkerSetupGate = { satisfied: boolean; status: string }

export async function awaitStructuredWorkerSetupGate(args: {
  runtime: Pick<OrcaRuntimeService, 'waitForSetupTerminalCompletion'>
  setup: WorkerSetupReceipt
  effects: WorkerEffect[]
  timeoutMs: number
}): Promise<StructuredWorkerSetupGate | null> {
  if (args.setup.startupPolicy !== 'wait-for-setup' || args.setup.state !== 'running') {
    return null
  }
  const setupTerminal = args.effects.find((effect) => effect.kind === 'setup')?.terminalId
  if (!setupTerminal) {
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      args.runtime.waitForSetupTerminalCompletion(setupTerminal).then((completion) => ({
        satisfied: completion.exitCode === 0,
        status: 'exited'
      })),
      new Promise<StructuredWorkerSetupGate>((resolve) => {
        timer = setTimeout(() => resolve({ satisfied: false, status: 'timeout' }), args.timeoutMs)
      })
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
