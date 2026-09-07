import { afterEach, expect, it, vi } from 'vitest'
import type { PushNotification } from '@orca-cloud/push-contract'
import { DurablePushStore } from './durable-push-store.js'
import { DurablePushWorker } from './durable-push-worker.js'
import { PushDispatcher } from './push-dispatcher.js'
import { PushDeviceRegistryStore } from './device-registry-store.js'
import { openInMemoryPushDatabase } from './push-database.js'
import type { PushDelivery } from './push-delivery-message.js'
import type { PushProviderOutcome } from './push-provider-outcome.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const note = (seq: number, overrides: Partial<PushNotification> = {}): PushNotification => ({
  notificationId: `note-${seq}`,
  notificationSeq: seq,
  notificationEpoch: 'epoch',
  source: 'agent-task-complete',
  agentState: 'finished',
  title: 'Done',
  body: 'Finished task',
  ...overrides
})
async function fixture() {
  const db = await openInMemoryPushDatabase()
  let time = 1_000_000
  const now = () => time
  const store = new DurablePushStore(db, now)
  const devices = new PushDeviceRegistryStore(db, now)
  const device = await devices.upsert({
    hostFingerprint: 'host',
    deviceId: 'phone',
    platform: 'android',
    token: 'test-token',
    filter: { sources: [], agentStates: [] }
  })
  if (!device.ok) throw new Error('registration failed')
  const send = vi.fn(async (_delivery: PushDelivery): Promise<PushProviderOutcome> => ({
    status: 'sent'
  }))
  const onRetry = vi.fn()
  const dispatcher = new PushDispatcher({ devices, fcm: { send } as never })
  const worker = new DurablePushWorker(store, dispatcher, { now, onRetry })
  cleanups.push(async () => {
    await worker.stop()
    await db.close()
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return {
    db,
    store,
    devices,
    worker,
    dispatcher,
    send,
    onRetry,
    now,
    registrationId: device.registrationId,
    accept: (notification: PushNotification) =>
      store.accept('host', device.registrationId, notification),
    advance: (ms: number) => {
      time += ms
    }
  }
}

it('waits for the real coalescing deadline and sends complete summaries', async () => {
  const h = await fixture()
  await h.accept(note(1))
  h.advance(2000)
  await h.accept(note(2, { agentState: 'needs-input' }))
  await h.worker.runDue()
  expect(h.send).not.toHaveBeenCalled()
  h.advance(1000)
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  expect(h.send.mock.calls[0]![0]).toMatchObject({
    title: 'Orca',
    body: '2 agents need attention',
    orca: {
      notificationSeq: 2,
      coalescedCount: 2,
      summaryMembers: [
        { notificationId: 'note-1', notificationSeq: 1, notificationEpoch: 'epoch' },
        { notificationId: 'note-2', notificationSeq: 2, notificationEpoch: 'epoch' }
      ]
    }
  })
  await h.accept(note(3))
  h.advance(3000)
  await h.worker.runDue()
  expect(h.send.mock.calls[1]![0]).toMatchObject({
    title: 'Done',
    body: 'Finished task',
    orca: { coalescedCount: 1 }
  })
  expect(h.onRetry).not.toHaveBeenCalled()
})

it('keeps untrackable bells individual and summaries scoped to each phone', async () => {
  const h = await fixture()
  const other = await h.devices.upsert({
    hostFingerprint: 'host',
    deviceId: 'phone2',
    platform: 'android',
    token: 'other-token',
    filter: { sources: [], agentStates: [] }
  })
  if (!other.ok) throw new Error('registration failed')
  await h.accept(note(1, { notificationId: undefined, source: 'terminal-bell', agentState: null }))
  await h.accept(note(2))
  await h.accept(note(3))
  await h.store.accept('host', other.registrationId, note(2))
  h.advance(3000)
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledTimes(3)
  const deliveries = h.send.mock.calls.map(([delivery]) => delivery)
  expect(deliveries.find((delivery) => delivery.orca.source === 'terminal-bell')).toMatchObject({
    collapseId: 'host:host',
    orca: { coalescedCount: 1 }
  })
  expect(deliveries.find((delivery) => delivery.orca.coalescedCount === 2)).toMatchObject({
    registrationId: h.registrationId,
    body: '2 updates'
  })
  expect(
    deliveries.find((delivery) => delivery.registrationId === other.registrationId)?.orca
      .coalescedCount
  ).toBe(1)
})

it('persists provider retry delay and resumes it through a new worker', async () => {
  const h = await fixture()
  h.send.mockResolvedValueOnce({
    status: 'error',
    reason: 'busy',
    retryable: true,
    retryAfterMs: 10000
  })
  await h.accept(note(1))
  h.advance(3000)
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  await h.worker.stop()
  const restarted = new DurablePushWorker(h.store, h.dispatcher, { now: h.now, onRetry: h.onRetry })
  h.advance(9999)
  await restarted.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  h.advance(1)
  await restarted.runDue()
  expect(h.send).toHaveBeenCalledTimes(2)
  expect(h.onRetry).toHaveBeenCalledOnce()
  expect(await h.store.pendingCount(h.registrationId)).toBe(0)
  await restarted.stop()
})

it('expires instead of shortening a provider delay beyond the delivery lifetime', async () => {
  const h = await fixture()
  h.send.mockResolvedValue({
    status: 'error',
    reason: 'busy',
    retryable: true,
    retryAfterMs: 600000
  })
  await h.accept(note(1))
  h.advance(3000)
  await h.worker.runDue()
  h.advance(600000)
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  expect(await h.store.pendingCount(h.registrationId)).toBe(0)
  expect(h.onRetry).not.toHaveBeenCalled()
})

it('rechecks the device before a persisted retry and does not send after unregistration', async () => {
  const h = await fixture()
  h.send.mockResolvedValue({ status: 'error', reason: 'timeout', retryable: true })
  await h.accept(note(1))
  h.advance(3000)
  await h.worker.runDue()
  await h.devices.deleteOwned('host', h.registrationId)
  h.advance(3000)
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  expect(await h.store.pendingCount(h.registrationId)).toBe(0)
})

it('joins active work on shutdown and leaves unclaimed work for the next instance', async () => {
  const h = await fixture()
  let finish!: (outcome: PushProviderOutcome) => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  h.send.mockImplementationOnce(() => {
    started()
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  await h.accept(note(1))
  h.advance(3000)
  const pending = h.worker.runDue()
  await entered
  await h.accept(note(2))
  h.advance(3000)
  let stopped = false
  const stopping = h.worker.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  finish({ status: 'sent' })
  await Promise.all([pending, stopping])
  expect(stopped).toBe(true)
  expect(h.send).toHaveBeenCalledOnce()
  const resumed = new DurablePushWorker(h.store, h.dispatcher, { now: h.now })
  await resumed.runDue()
  expect(h.send).toHaveBeenCalledTimes(2)
  await resumed.stop()
})

it('runs due work on its timer and releases the timer on stop', async () => {
  const h = await fixture()
  vi.useFakeTimers()
  await h.accept(note(1))
  h.worker.start()
  h.worker.start()
  expect(vi.getTimerCount()).toBe(1)
  h.advance(3000)
  await vi.advanceTimersByTimeAsync(1000)
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  await h.worker.stop()
  expect(vi.getTimerCount()).toBe(0)
})
