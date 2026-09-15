// Regression for ChatGPT round-1 on the MAINT-1 rebase (PR #18, P1):
// an unconfirmed force-kill must not resolve as successful shutdown.
// Only an observed exit proves death; otherwise close/dispose reject with
// BRIDGE_EXIT_UNPROVEN and dispose retains the child for a later retry.
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { BridgeHost } from './bridge-host'
import { BridgeUnavailableError } from './bridge-protocol'

// Fake helper that swallows stdin EOF, SIGTERM, and SIGKILL: kill() records
// the signal but no exit is ever observed.
class SwallowingProc {
  exitCode: null = null
  signalCode: null = null
  readonly killCalls: string[] = []
  private readonly listeners = new Set<(...args: never[]) => void>()
  kill(signal?: string): boolean {
    this.killCalls.push(signal ?? '')
    return true
  }
  once(_event: string, fn: (...args: never[]) => void): this {
    this.listeners.add(fn)
    return this
  }
  off(_event: string, fn: (...args: never[]) => void): this {
    this.listeners.delete(fn)
    return this
  }
}

function hostWithSwallower(): { host: BridgeHost; proc: SwallowingProc } {
  const host = new BridgeHost({
    bridgeCommand: 'node',
    bridgeArgs: [],
    workspaceRoot: '/tmp/ws',
    closeGraceMs: 10,
    killGraceMs: 10
  })
  const proc = new SwallowingProc()
  ;(host as unknown as { proc: unknown }).proc = proc as unknown as ChildProcess
  return { host, proc }
}

async function closeError(host: BridgeHost, mode: 'graceful' | 'force'): Promise<unknown> {
  try {
    await host.close(mode)
  } catch (error) {
    return error
  }
  return null
}

describe('BridgeHost unproven-exit shutdown', () => {
  it('close(force) rejects BRIDGE_EXIT_UNPROVEN instead of synthetic success', async () => {
    const { host, proc } = hostWithSwallower()
    const error = await closeError(host, 'force')
    expect(error).toBeInstanceOf(BridgeUnavailableError)
    expect((error as BridgeUnavailableError).code).toBe('BRIDGE_EXIT_UNPROVEN')
    expect(proc.killCalls).toEqual(['SIGKILL'])
  })

  it('dispose rejects, retains the child for retry, and settles once an exit is observed', async () => {
    const { host, proc } = hostWithSwallower()
    const first = await host.dispose().then(
      () => null,
      (error: unknown) => error
    )
    expect(first).toBeInstanceOf(BridgeUnavailableError)
    expect((first as BridgeUnavailableError).code).toBe('BRIDGE_EXIT_UNPROVEN')
    // Retained, not orphaned: a second dispose re-attempts the kill.
    const second = await host.dispose().then(
      () => null,
      (error: unknown) => error
    )
    expect(second).toBeInstanceOf(BridgeUnavailableError)
    expect(proc.killCalls.length).toBeGreaterThanOrEqual(2)
    // A late observed exit settles teardown.
    ;(host as unknown as { exited: unknown }).exited = { code: null, signal: 'SIGKILL' }
    await host.dispose()
  })
})
