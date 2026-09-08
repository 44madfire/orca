// A shutdown timeout removes bookkeeping without proving the process exited.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    process: 'zsh',
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import { SshPtyProvider } from '../main/providers/ssh-pty-provider'
import { toAppSshPtyId } from '../shared/ssh-pty-id'
import { reconcileLegacyWorkerCandidate } from '../main/runtime/runtime-legacy-worker-terminal-recovery-candidate'
import type { LegacyWorkerRecoveryResolution } from '../main/runtime/runtime-legacy-worker-terminal-recovery-types'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'
import { parseRelayPtyMintEpoch } from '../shared/relay-pty-mint-epoch'

describe('SSH exit certification across relay shutdown', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const { spawnPty } = createPtyRequestHelpers(() => dispatcher)

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  async function capabilities(): Promise<Record<string, unknown>> {
    return (await dispatcher.callRequest('pty.getCapabilities', {})) as Record<string, unknown>
  }

  /**
   * The rule an older client applied, reproduced here rather than shipped: an id missing from
   * `pty.listProcesses` was an exit whenever its mint epoch matched one the host published. Mixed
   * client and host versions are the normal state (docs/reference/remote-wire-compatibility.md),
   * so what this host publishes has to keep that client unable to reach a verdict — a host cannot
   * fix an old client, only decline to hand it the second half of the inference.
   */
  async function inferLivenessFromListingAndEpoch(relayPtyId: string): Promise<boolean | null> {
    const listed = (await dispatcher.callRequest('pty.listProcesses', {
      includeForegroundProcessEvidence: false
    })) as { id?: unknown }[]
    if (listed.some((session) => session.id === relayPtyId)) {
      return true
    }
    const mintEpoch = parseRelayPtyMintEpoch(relayPtyId)
    if (!mintEpoch) {
      return null
    }
    return Object.values(await capabilities()).includes(mintEpoch) ? false : null
  }

  it('publishes nothing that names the generation which minted its PTY ids', async () => {
    const { id } = await spawnPty()

    const mintEpoch = parseRelayPtyMintEpoch(id)
    expect(mintEpoch).toBeTruthy()
    expect(Object.values(await capabilities())).not.toContain(mintEpoch)
  })

  it('leaves a shutdown-removed id unverifiable for a client that infers from listings', async () => {
    const { id } = await spawnPty()
    const disposal = handler.dispose()
    await vi.advanceTimersByTimeAsync(8_001)
    await disposal

    expect(await inferLivenessFromListingAndEpoch(id)).toBeNull()
  })

  it('keeps that inference unreachable when a failed kill leaves the relay serving', async () => {
    const { id } = await spawnPty()
    const failedKill = vi.fn<() => void>(() => {
      throw new Error('host refused kill')
    })
    mockPtySpawn.mockReturnValueOnce({ ...mockPtyInstance, kill: failedKill })
    await spawnPty()
    const disposal = handler.dispose().catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(8_001)
    expect(await disposal).toMatchObject({ message: 'host refused kill' })
    failedKill.mockImplementation(() => {})

    expect(() => process.kill(process.pid, 0)).not.toThrow()
    expect(await inferLivenessFromListingAndEpoch(id)).toBeNull()
  })
  it('does not certify exit after shutdown bookkeeping removes an unexited PTY', async () => {
    const { id } = await spawnPty()
    const provider = new SshPtyProvider('review-target', {
      request: (method: string, params: Record<string, unknown>) =>
        dispatcher.callRequest(method, params),
      onNotification: () => () => {},
      onRequest: () => () => {}
    } as never)
    const appId = toAppSshPtyId('review-target', id)
    expect(await provider.probePtyLiveness(appId)).toBe(true)
    const disposal = handler.dispose()
    await vi.advanceTimersByTimeAsync(8_001)
    await disposal
    expect(dispatcher._notifications.filter((event) => event.method === 'pty.exit')).toEqual([])
    expect(mockPtyInstance.kill).toHaveBeenCalled()
    expect(() => process.kill(process.pid, 0)).not.toThrow()
    expect(handler.activePtyCount).toBe(0)
    expect(await provider.probePtyLiveness(appId)).toBeNull()
  })

  it('keeps missing shutdown records unverifiable when another failed kill leaves the relay serving', async () => {
    const { id } = await spawnPty()
    const failedKill = vi.fn<() => void>(() => {
      throw new Error('host refused kill')
    })
    mockPtySpawn.mockReturnValueOnce({ ...mockPtyInstance, kill: failedKill })
    await spawnPty()
    const disposal = handler.dispose().catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(8_001)
    expect(await disposal).toMatchObject({ message: 'host refused kill' })
    expect(handler.activePtyCount).toBe(1)
    const provider = new SshPtyProvider('review-target', {
      request: (method: string, params: Record<string, unknown>) =>
        dispatcher.callRequest(method, params),
      onNotification: () => () => {},
      onRequest: () => () => {}
    } as never)
    expect(() => process.kill(process.pid, 0)).not.toThrow()
    expect(dispatcher._notifications.filter((event) => event.method === 'pty.exit')).toEqual([])
    // Permit cleanup of the second fixture after the assertion.
    failedKill.mockImplementation(() => {})
    const appId = toAppSshPtyId('review-target', id)
    const verdict = await provider.probePtyLiveness(appId)
    const pendingResolutions: LegacyWorkerRecoveryResolution[] = []
    const deferredDispatchIds = new Set<string>()
    await reconcileLegacyWorkerCandidate({
      controller: {} as never,
      ports: { isPtyProvenAbsent: async () => verdict === false } as never,
      options: {},
      candidate: { dispatchId: 'review-worker', ptyId: appId } as never,
      workspace: {} as never,
      resolvedWorktrees: [],
      inventory: { livePtyIds: new Set() } as never,
      pendingResolutions,
      deferredDispatchIds
    })
    expect(pendingResolutions).toEqual([])
    expect([...deferredDispatchIds]).toEqual(['review-worker'])
  })
})
