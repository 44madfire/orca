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
          onExit: () => () => {},
          ackData,
          // Absent on the web remote client and partial test APIs: the watchdog refuses to
          // start without it, and the dispatcher must then keep today's ACK-at-return.
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
