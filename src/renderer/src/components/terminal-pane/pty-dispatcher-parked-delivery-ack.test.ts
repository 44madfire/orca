/**
 * The held-ACK contract, driven through the real dispatcher rather than the buffer helper.
 *
 * Why it matters: `pty:data` for a PTY with no registered handler used to be parked AND
 * ACKed. Debt for a dead pane was therefore zero, and the delivery watchdog's stall
 * predicate needs `inFlightTotalChars > 0` — so it was blind by construction, main's flow
 * control read healthy, and the shell kept flooding a pane that rendered nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))

const PTY_ID = 'pty-parked-ack'
const BOOT_OUTPUT = 'setup-script output'

type PtyDataPayload = { id: string; data: string; rawLength?: number }

describe('parked pty:data delivery credit', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const ackData = vi.fn()
  let emitPtyData: (payload: PtyDataPayload) => void
  let emitPtyExit: (payload: { id: string; code: number }) => void

  function installWindow(options: { deliveryWatchdog: boolean }): void {
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
          onExit: (listener: (payload: { id: string; code: number }) => void) => {
            emitPtyExit = listener
            return () => {}
          },
          ackData,
          // Partial test APIs omit it, and the watchdog refuses to start without it, so the
          // dispatcher keeps today's ACK-at-return. Note the web remote client is NOT this
          // case — it stubs a real one and does arm the watchdog. Nothing parks there because
          // its `onData` never emits, so this branch is not what makes that surface safe.
          ...(options.deliveryWatchdog
            ? { reportRendererDeliveryState: vi.fn(async () => null) }
            : {})
        }
      }
    } as unknown as typeof window
  }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    ackData.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('holds the ACK for bytes parked with no handler, and repays it exactly once on bind', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher, registerEagerPtyBuffer } = await import('./pty-dispatcher')
    const { getParkedPreHandlerCharsByPty } = await import('./pty-parked-delivery-debt')
    ensurePtyDispatcher()

    emitPtyData({ id: PTY_ID, data: BOOT_OUTPUT })

    expect(ackData).not.toHaveBeenCalled()
    expect(getParkedPreHandlerCharsByPty()).toEqual({ [PTY_ID]: BOOT_OUTPUT.length })

    // The real bind seam: registering the eager buffer drains the parked chunks.
    registerEagerPtyBuffer(PTY_ID, () => {})

    expect(ackData.mock.calls).toEqual([[PTY_ID, BOOT_OUTPUT.length, BOOT_OUTPUT.length]])
    expect(getParkedPreHandlerCharsByPty()).toEqual({})
  })

  it('credits the ACK at return on a surface with no delivery watchdog', async () => {
    installWindow({ deliveryWatchdog: false })
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { getParkedPreHandlerCharsByPty } = await import('./pty-parked-delivery-debt')
    const { clearPreHandlerPtyState } = await import('./pty-pre-handler-buffer')
    ensurePtyDispatcher()

    emitPtyData({ id: PTY_ID, data: BOOT_OUTPUT })

    // Held debt with no heal lane would be a paused shell nobody can unstick.
    expect(ackData.mock.calls).toEqual([[PTY_ID, BOOT_OUTPUT.length, BOOT_OUTPUT.length]])
    expect(getParkedPreHandlerCharsByPty()).toEqual({})
    clearPreHandlerPtyState(PTY_ID)
  })

  it('leaves a bound pane on the parse-deferred ACK it already had', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher, ptyDataHandlers } = await import('./pty-dispatcher')
    const { getParkedPreHandlerCharsByPty } = await import('./pty-parked-delivery-debt')
    ensurePtyDispatcher()
    ptyDataHandlers.set(PTY_ID, () => {})

    emitPtyData({ id: PTY_ID, data: BOOT_OUTPUT })

    expect(ackData.mock.calls).toEqual([[PTY_ID, BOOT_OUTPUT.length, BOOT_OUTPUT.length]])
    expect(getParkedPreHandlerCharsByPty()).toEqual({})
    ptyDataHandlers.delete(PTY_ID)
  })

  it('repays parked credit on exit, when no handler will ever drain it', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { getParkedPreHandlerCharsByPty } = await import('./pty-parked-delivery-debt')
    ensurePtyDispatcher()

    emitPtyData({ id: PTY_ID, data: BOOT_OUTPUT })
    expect(getParkedPreHandlerCharsByPty()).toEqual({ [PTY_ID]: BOOT_OUTPUT.length })

    // No primary exit handler, so the exit is only buffered and no drain ever runs. Main
    // deletes this pty's accounting on exit, so the write-off lane cannot forgive it either:
    // un-repaid here, the debt pins the session in-flight total until the window reloads.
    emitPtyExit({ id: PTY_ID, code: 0 })

    expect(getParkedPreHandlerCharsByPty()).toEqual({})
    expect(ackData).toHaveBeenCalledWith(PTY_ID, BOOT_OUTPUT.length, BOOT_OUTPUT.length)
  })

  it('leaves no processed-char total behind for the next incarnation of a reused id', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { getProcessedPtyCharTotals } = await import('./terminal-pty-ack-gate')
    ensurePtyDispatcher()

    emitPtyData({ id: PTY_ID, data: BOOT_OUTPUT })
    emitPtyExit({ id: PTY_ID, code: 0 })

    // Settling ACKs on the way out, which re-adds to the cumulative total. Clearing before
    // delivery left that total re-seeded, and ids are reused — a redeployed relay renumbers
    // from pty-1 — so main credited the next incarnation for bytes nobody had parsed.
    expect(getProcessedPtyCharTotals()).toEqual({})
  })

  it('clears the processed total even when exit delivery itself credits an ACK', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher, ptyExitHandlers } = await import('./pty-dispatcher')
    const { ackPtyData, getProcessedPtyCharTotals } = await import('./terminal-pty-ack-gate')
    ensurePtyDispatcher()

    // An exit owner that flushes buffered writes credits chars while the exit is delivered.
    // The clear has to be the last word on this id, whatever delivery did.
    ptyExitHandlers.set(PTY_ID, () => ackPtyData(PTY_ID, BOOT_OUTPUT.length))

    emitPtyExit({ id: PTY_ID, code: 0 })

    expect(ackData).toHaveBeenCalledWith(PTY_ID, BOOT_OUTPUT.length, BOOT_OUTPUT.length)
    expect(getProcessedPtyCharTotals()).toEqual({})
    ptyExitHandlers.delete(PTY_ID)
  })

  it('holds the credit in rawLength chars, not the UTF-8 byte count', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { getParkedPreHandlerCharsByPty } = await import('./pty-parked-delivery-debt')
    const { clearPreHandlerPtyState } = await import('./pty-pre-handler-buffer')
    ensurePtyDispatcher()

    // Main counts UTF-16 chars and says so via rawLength; the buffer counts UTF-8 bytes.
    emitPtyData({ id: PTY_ID, data: 'ééé', rawLength: 3 })

    expect(getParkedPreHandlerCharsByPty()).toEqual({ [PTY_ID]: 3 })
    clearPreHandlerPtyState(PTY_ID)
    expect(ackData.mock.calls).toEqual([[PTY_ID, 3, 3]])
  })
})
