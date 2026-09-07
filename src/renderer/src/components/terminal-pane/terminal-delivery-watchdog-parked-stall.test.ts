/**
 * The per-PTY lane, end to end: dispatcher parks bytes → watchdog tick → remount or write-off.
 *
 * The mask this closes is arithmetic. On a machine with a hundred terminals, "any pty:data
 * event since the last tick" and session-global `msSinceLastAck` read healthy essentially
 * always, so the tick used to return before ever asking main — and one pane wedged with no
 * data handler stayed invisible while its shell kept flooding it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyRendererDeliveryHealthReply } from '../../../../shared/pty-renderer-delivery-health'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

const storeState = {
  ptyIdsByTabId: {} as Record<string, string[]>,
  getTab: vi.fn((tabId: string) => ({ id: tabId })),
  remountTerminalTabForRecovery: vi.fn(() => true)
}
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

const INTERVAL_MS = 15_000
const WEDGED_PTY_ID = 'pty-wedged'
const LIVE_PTY_ID = 'pty-live'
const WEDGED_TAB_ID = 'tab-wedged'
const WEDGED_OUTPUT = 'output nobody renders'

/** Main is healthy overall — some other pane ACKed a moment ago — but holds this pane's debt. */
const BUSY_MAIN: PtyRendererDeliveryHealthReply = {
  inFlightTotalChars: WEDGED_OUTPUT.length,
  inFlightPtyCount: 1,
  msSinceLastAck: 200,
  stalledPtys: [{ id: WEDGED_PTY_ID, inFlightChars: WEDGED_OUTPUT.length, msSinceLastAck: null }]
}

type PtyDataPayload = { id: string; data: string }

describe('per-PTY parked delivery stall', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const reportMock = vi.fn<(args: unknown) => Promise<PtyRendererDeliveryHealthReply | null>>()
  const reattachMock = vi.fn()
  let emitPtyData: (payload: PtyDataPayload) => void
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    reportMock.mockReset()
    reattachMock.mockClear()
    storeState.ptyIdsByTabId = {}
    storeState.remountTerminalTabForRecovery.mockClear()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          onData: (listener: (payload: PtyDataPayload) => void) => {
            emitPtyData = listener
            return () => {}
          },
          onReplay: () => () => {},
          onExit: () => () => {},
          ackData: vi.fn(),
          hasPty: vi.fn(async () => true),
          reportRendererDeliveryState: reportMock,
          getPtyDataListenerCount: () => 1
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  /** Arms the watchdog with assertable deps first; the dispatcher's own start then no-ops. */
  async function startDispatcherAndWatchdog(): Promise<{
    parkedCharsByPty: () => Record<string, number>
    streamLiveOutput: () => void
  }> {
    const watchdog = await import('./terminal-delivery-watchdog')
    const { recoverParkedPanes } = await import('./terminal-parked-pane-recovery')
    watchdog.startTerminalDeliveryWatchdog({
      reattachPushListeners: reattachMock,
      hasAttachedPtys: () => true,
      // The real ownership resolver over the mocked store, so the remount path is not stubbed.
      recoverParkedPanes: async (ptyIds) => recoverParkedPanes(ptyIds)
    })
    const dispatcher = await import('./pty-dispatcher')
    dispatcher.ptyDataHandlers.set(LIVE_PTY_ID, () => {})
    dispatcher.ensurePtyDispatcher()
    const { getParkedPreHandlerCharsByPty } = await import('./pty-parked-delivery-debt')
    return {
      parkedCharsByPty: getParkedPreHandlerCharsByPty,
      streamLiveOutput: () => emitPtyData({ id: LIVE_PTY_ID, data: 'still streaming' })
    }
  }

  function healCalls(): unknown[] {
    return reportMock.mock.calls
      .map((call) => call[0])
      .filter((args) => (args as { heal?: boolean }).heal === true)
  }

  it('remounts the owning tab of a pane parked across two ticks while other panes stream', async () => {
    storeState.ptyIdsByTabId = { [WEDGED_TAB_ID]: [WEDGED_PTY_ID] }
    reportMock.mockResolvedValue(BUSY_MAIN)
    const { parkedCharsByPty, streamLiveOutput } = await startDispatcherAndWatchdog()

    emitPtyData({ id: WEDGED_PTY_ID, data: WEDGED_OUTPUT })
    expect(parkedCharsByPty()).toEqual({ [WEDGED_PTY_ID]: WEDGED_OUTPUT.length })

    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(storeState.remountTerminalTabForRecovery).not.toHaveBeenCalled()
    expect(reportMock.mock.calls[0]![0]).toMatchObject({
      parkedCharsByPty: { [WEDGED_PTY_ID]: WEDGED_OUTPUT.length }
    })

    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    // The remount is the heal for an owned pane: rebinding drains the parked bytes and
    // their held ACK repays the debt. No push listener churn for one pane.
    expect(storeState.remountTerminalTabForRecovery).toHaveBeenCalledWith(WEDGED_TAB_ID)
    expect(reattachMock).not.toHaveBeenCalled()
    expect(healCalls()).toHaveLength(0)
  })

  it('writes off an orphan-parked pane and drops the superseded bytes', async () => {
    reportMock.mockImplementation((args) =>
      Promise.resolve(
        (args as { heal?: boolean }).heal
          ? {
              inFlightTotalChars: 0,
              inFlightPtyCount: 0,
              msSinceLastAck: 0,
              writtenOff: [{ id: WEDGED_PTY_ID, writtenOffChars: WEDGED_OUTPUT.length }]
            }
          : BUSY_MAIN
      )
    )
    const { parkedCharsByPty, streamLiveOutput } = await startDispatcherAndWatchdog()

    // No tab owns this pty, so there is nothing to remount; only a write-off frees the debt.
    emitPtyData({ id: WEDGED_PTY_ID, data: WEDGED_OUTPUT })
    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    expect(storeState.remountTerminalTabForRecovery).not.toHaveBeenCalled()
    expect(healCalls()).toHaveLength(1)
    expect(healCalls()[0]).toMatchObject({
      heal: true,
      parkedCharsByPty: { [WEDGED_PTY_ID]: WEDGED_OUTPUT.length }
    })
    // A very late bind must not paint bytes the restore marker already superseded.
    expect(parkedCharsByPty()).toEqual({})
    expect(reattachMock).not.toHaveBeenCalled()
  })

  it('leaves the ordinary pre-attach race alone: parked bytes that drain never heal', async () => {
    storeState.ptyIdsByTabId = { [WEDGED_TAB_ID]: [WEDGED_PTY_ID] }
    reportMock.mockResolvedValue(BUSY_MAIN)
    const { parkedCharsByPty, streamLiveOutput } = await startDispatcherAndWatchdog()
    const dispatcher = await import('./pty-dispatcher')

    emitPtyData({ id: WEDGED_PTY_ID, data: WEDGED_OUTPUT })
    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    // The pane binds, which is what the buffer exists for.
    dispatcher.registerEagerPtyBuffer(WEDGED_PTY_ID, () => {})
    expect(parkedCharsByPty()).toEqual({})

    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)

    expect(storeState.remountTerminalTabForRecovery).not.toHaveBeenCalled()
    expect(healCalls()).toHaveLength(0)
  })
})
