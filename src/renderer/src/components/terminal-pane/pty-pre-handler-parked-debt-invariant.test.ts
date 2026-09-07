/**
 * The ratchet for the inverse bug. Holding the ACK for parked bytes is only safe while every
 * exit from this buffer repays it: a claim that never settles is permanent renderer-held
 * debt, and main answers permanent debt by pausing a healthy shell forever.
 *
 * So: for every sequence, total settled credit == total claimed credit, and nothing stays
 * parked. Any future exit path that forgets to settle turns this red.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  bufferPreHandlerPtyData,
  clearConsumedPreHandlerPtyExit,
  clearPreHandlerPtyState,
  currentPreHandlerPtySequence,
  discardParkedPtyDataAfterWriteOff,
  discardPreHandlerPtyState,
  discardPreHandlerPtyStateFromPriorIncarnation,
  drainPreHandlerPtyData
} from './pty-pre-handler-buffer'
import { getParkedPreHandlerCharsByPty } from './pty-parked-delivery-debt'

const PRE_HANDLER_PTY_DATA_MAX_BYTES = 512 * 1024
const PRE_HANDLER_PTY_DATA_MAX_PTYS = 64
const PTY_ID = 'pty-parked-debt'
const LRU_PTY_IDS = Array.from(
  { length: PRE_HANDLER_PTY_DATA_MAX_PTYS + 1 },
  (_, index) => `pty-parked-lru-${index}`
)

/** Stands in for the dispatcher's claim on the open delivery credit: one settle per claim,
 *  idempotent, exactly like `takeCurrentTerminalDeliveryCredit`. */
function createDeliveryCreditLedger(): {
  claimedChars: () => number
  settledChars: () => number
  park: (ptyId: string, data: string) => void
} {
  let claimedChars = 0
  let settledChars = 0
  return {
    claimedChars: () => claimedChars,
    settledChars: () => settledChars,
    park: (ptyId, data) => {
      claimedChars += data.length
      let settled = false
      bufferPreHandlerPtyData(ptyId, data, undefined, {
        chars: data.length,
        settle: () => {
          if (settled) {
            return
          }
          settled = true
          settledChars += data.length
        }
      })
    }
  }
}

function expectNoOutstandingDebt(ledger: ReturnType<typeof createDeliveryCreditLedger>): void {
  expect(ledger.settledChars()).toBe(ledger.claimedChars())
  expect(getParkedPreHandlerCharsByPty()).toEqual({})
}

describe('parked pre-handler delivery debt always settles', () => {
  afterEach(() => {
    clearConsumedPreHandlerPtyExit(PTY_ID)
    clearPreHandlerPtyState(PTY_ID)
    for (const ptyId of LRU_PTY_IDS) {
      clearPreHandlerPtyState(ptyId)
    }
  })

  it('holds the credit while parked and repays it on drain', () => {
    const ledger = createDeliveryCreditLedger()

    ledger.park(PTY_ID, 'prompt')
    ledger.park(PTY_ID, ' and motd')
    expect(getParkedPreHandlerCharsByPty()).toEqual({
      [PTY_ID]: 'prompt'.length + ' and motd'.length
    })
    expect(ledger.settledChars()).toBe(0)

    const drained: string[] = []
    drainPreHandlerPtyData(PTY_ID, (data) => drained.push(data))

    expect(drained).toEqual(['prompt', ' and motd'])
    expectNoOutstandingDebt(ledger)
  })

  it('repays evicted chunks: the byte cap can bite before main pauses the producer', () => {
    const ledger = createDeliveryCreditLedger()

    // The buffer caps UTF-8 BYTES while main's in-flight window counts UTF-16 chars, so an
    // eviction can happen with main still crediting; the evicted credit must not be stranded.
    ledger.park(PTY_ID, 'x'.repeat(PRE_HANDLER_PTY_DATA_MAX_BYTES))
    ledger.park(PTY_ID, 'y'.repeat(1024))
    expect(ledger.settledChars()).toBe(PRE_HANDLER_PTY_DATA_MAX_BYTES)

    drainPreHandlerPtyData(PTY_ID, () => {})

    expectNoOutstandingDebt(ledger)
  })

  it('repays a whole PTY evicted by the per-PTY LRU cap', () => {
    const ledger = createDeliveryCreditLedger()

    for (const ptyId of LRU_PTY_IDS) {
      ledger.park(ptyId, 'startup')
    }

    // The oldest id was pushed out of the map entirely; its bytes will never reach a pane.
    expect(getParkedPreHandlerCharsByPty()[LRU_PTY_IDS[0]]).toBeUndefined()
    expect(ledger.settledChars()).toBe('startup'.length)

    for (const ptyId of LRU_PTY_IDS) {
      drainPreHandlerPtyData(ptyId, () => {})
    }
    expectNoOutstandingDebt(ledger)
  })

  it('repays bytes dropped because the PTY state is discarded', () => {
    const ledger = createDeliveryCreditLedger()

    discardPreHandlerPtyState(PTY_ID)
    ledger.park(PTY_ID, 'kill-flush output')

    // Dropped, exactly as before — but dropping still has to ACK.
    expectNoOutstandingDebt(ledger)
  })

  it('repays an empty chunk that never becomes a buffered record', () => {
    const ledger = createDeliveryCreditLedger()

    ledger.park(PTY_ID, '')

    expectNoOutstandingDebt(ledger)
  })

  it('repays on clear, on write-off discard, and on the prior-incarnation fence', () => {
    const ledger = createDeliveryCreditLedger()

    ledger.park(PTY_ID, 'cleared')
    clearPreHandlerPtyState(PTY_ID)
    expectNoOutstandingDebt(ledger)

    ledger.park(PTY_ID, 'written-off')
    discardParkedPtyDataAfterWriteOff([PTY_ID, 'pty-never-seen'])
    expectNoOutstandingDebt(ledger)

    ledger.park(PTY_ID, 'previous incarnation')
    discardPreHandlerPtyStateFromPriorIncarnation(PTY_ID, currentPreHandlerPtySequence())
    expectNoOutstandingDebt(ledger)
  })

  it('repays the whole PTY when a draining handler throws', () => {
    const ledger = createDeliveryCreditLedger()

    ledger.park(PTY_ID, 'first')
    ledger.park(PTY_ID, 'second')

    expect(() =>
      drainPreHandlerPtyData(PTY_ID, () => {
        throw new Error('xterm write threw')
      })
    ).toThrow('xterm write threw')

    // The chunks are already out of the buffer, so their debt would have no payer left.
    expectNoOutstandingDebt(ledger)
  })
})
