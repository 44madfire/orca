/**
 * "Owned" has to mean the held ACK has a payer.
 *
 * The watchdog excludes owned ids from BOTH heal lanes — the write-off lane and the per-PTY
 * stalled lane — on the grounds that a remount will drain their bytes and repay the credit.
 * So an id reported as owned when no remount can happen is excluded forever: main keeps that
 * pty's in-flight window full and pauses a perfectly healthy shell, with no path back.
 *
 * Ownership therefore tracks the recovery's own verdict, not the store's `ptyIdsByTabId`,
 * which only says a tab once listed the id. The converse matters just as much: a request that
 * was declined but re-queued IS owned, because its bytes are about to be drained — reporting
 * it unowned would hand the write-off lane output the imminent rebind was going to render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PTY_ID = 'pty-parked-owner'
const TAB_ID = 'tab-parked-owner'

const storeState = {
  ptyIdsByTabId: {} as Record<string, string[]>,
  getTab: vi.fn((tabId: string) => ({ id: tabId }) as { id: string; viewMode?: string }),
  remountTerminalTabForRecovery: vi.fn((_tabId: string) => true)
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

describe('parked pane ownership', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    storeState.ptyIdsByTabId = { [TAB_ID]: [PTY_ID] }
    storeState.getTab = vi.fn((tabId: string) => ({ id: tabId }))
    storeState.remountTerminalTabForRecovery = vi.fn(() => true)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.useRealTimers()
  })

  async function recover(): Promise<string[]> {
    const { recoverParkedPanes } = await import('./terminal-parked-pane-recovery')
    return recoverParkedPanes([PTY_ID])
  }

  it('claims a pty whose tab actually remounted', async () => {
    expect(await recover()).toEqual([PTY_ID])
    expect(storeState.remountTerminalTabForRecovery).toHaveBeenCalledWith(TAB_ID)
  })

  it('disclaims a pty whose tab left the store, so the write-off lane can forgive it', async () => {
    // remountTerminalTabForRecovery answers false when the tab is gone. Recovery does not
    // even re-queue this one — its own comment says retrying is pointless — so if ownership
    // still claimed it, nothing anywhere would ever repay the credit.
    storeState.remountTerminalTabForRecovery = vi.fn(() => false)

    expect(await recover()).toEqual([])
  })

  it('disclaims a pty whose tab is in chat view, which refuses recovery unconditionally', async () => {
    storeState.getTab = vi.fn((tabId: string) => ({ id: tabId, viewMode: 'chat' as const }))

    expect(await recover()).toEqual([])
    expect(storeState.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })

  it('keeps claiming a pty whose remount was declined but re-queued', async () => {
    // The first call consumes the tab's recovery budget; the second lands inside the cooldown
    // and is re-queued rather than refused. Its bytes are about to be drained by the pending
    // retry, so writing them off here would discard output, not rescue it.
    const { recoverParkedPanes } = await import('./terminal-parked-pane-recovery')
    const { hasPendingTerminalPaneRecovery } = await import('./terminal-pane-recovery')
    expect(await recoverParkedPanes([PTY_ID])).toEqual([PTY_ID])

    storeState.remountTerminalTabForRecovery = vi.fn(() => true)
    const claimed = await recoverParkedPanes([PTY_ID])

    expect(storeState.remountTerminalTabForRecovery).not.toHaveBeenCalled()
    expect(hasPendingTerminalPaneRecovery(TAB_ID)).toBe(true)
    expect(claimed).toEqual([PTY_ID])
  })

  it('disclaims a pty no tab lists at all', async () => {
    storeState.ptyIdsByTabId = {}

    expect(await recover()).toEqual([])
    expect(storeState.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })
})
