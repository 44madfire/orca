import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtyIpcSession } from './pty/session'
import { PtyPendingDataDrainQueue } from './pty-pending-data-drain-queue'
import { sendPtyDataToRenderer } from './pty/delivery/payload'
import { writeOffLostRendererDelivery } from './pty/delivery/accounting'
import { handleRendererDeliveryStateReport } from './pty/delivery/renderer-delivery-state-report'
import {
  createSshPtyOutputIntakeHarness,
  sshPtyOutputEvent
} from './ssh-pty-output-intake-test-harness'

vi.mock('./pty/provider/registry', () => ({ tryGetProviderForPty: () => undefined }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('SSH delivery heal parser credit', () => {
  it('settles old 201 loss but holds the fresh 199 projection until parser completion', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = createPtyIpcSession({
      mainWindow: { webContents: { send: vi.fn() } } as never
    })
    session.pendingData = new PtyPendingDataDrainQueue(() => 'active')
    session.readCurrentPtyRendererDeliveryDebugSnapshot = () => ({}) as never
    session.schedulePendingDataAfterCreditReport = vi.fn()
    session.writeOffLostRendererDelivery = (report, ids) =>
      writeOffLostRendererDelivery(session, report, ids)
    const id = 'ssh:connection@@pty-1'
    const harness = createSshPtyOutputIntakeHarness({
      project: (event, projection) => {
        sendPtyDataToRenderer(session, event.id, event, [projection.identity.projectionSemanticsId])
      }
    })
    session.sshOutputIntake = harness.intake
    try {
      const lost = harness.intake.acceptData(
        sshPtyOutputEvent({
          id,
          data: 'x'.repeat(201),
          rawLength: 201
        })
      )
      harness.completions[0]!.resolve()
      await lost
      expect(
        handleRendererDeliveryStateReport(session, {
          receivedCharsByPty: {},
          processedCharsByPty: {},
          heal: true
        }).writtenOff
      ).toEqual([{ id, writtenOffChars: 201 }])
      expect(harness.intake.getDebugSnapshot().projection.records).toBe(0)

      const fresh = harness.intake.acceptData(
        sshPtyOutputEvent({
          id,
          data: 'y'.repeat(199),
          rawLength: 199
        })
      )
      harness.completions[1]!.resolve()
      await fresh
      vi.advanceTimersByTime(10_000)
      const held = handleRendererDeliveryStateReport(session, {
        receivedCharsByPty: { [id]: 199 },
        processedCharsByPty: {},
        heal: true
      })
      expect(held.writtenOff).toBeUndefined()
      expect(held.inFlightTotalChars).toBe(199)
      expect(harness.intake.getDebugSnapshot().projection.records).toBe(1)
      const settled = handleRendererDeliveryStateReport(session, {
        receivedCharsByPty: { [id]: 199 },
        processedCharsByPty: { [id]: 199 }
      })
      expect(settled.inFlightTotalChars).toBe(0)
      expect(harness.intake.getDebugSnapshot().projection.records).toBe(0)
    } finally {
      harness.intake.dispose()
    }
  })
})
