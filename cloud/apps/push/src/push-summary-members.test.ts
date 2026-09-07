import { expect, it } from 'vitest'
import type { PushNotification } from '@orca-cloud/push-contract'
import { openInMemoryPushDatabase } from './push-database.js'
import { DurablePushStore } from './durable-push-store.js'
import { buildPushDelivery, canCoalescePushNotifications, orcaDataStrings } from './push-delivery-message.js'
import { apnsBody } from './apns-client.js'

const notification = (seq: number, id = `agent-${seq}`): PushNotification => ({
  notificationId: id, notificationEpoch: 'epoch', notificationSeq: seq,
  source: 'agent-task-complete', agentState: 'finished', title: 'Done', body: ''
})
it('partitions a burst into durable, complete summaries within the provider payload budget', async () => {
  const database = await openInMemoryPushDatabase()
  try {
    const store = new DurablePushStore(database, () => 1000)
    const expected = Array.from({ length: 70 }, (_, index) => notification(index))
    expected.push(notification(70, 'a'.repeat(1800)), notification(71, 'b'.repeat(1800)))
    for (const item of expected) expect(await store.accept('host', 'phone', item)).toBe('queued')
    const recovered: number[] = []
    const collapseIds = new Set<string>()
    for (let index = 0; index < expected.length; index++) {
      const batch = await store.claim('phone', true)
      if (!batch) break
      const delivery = buildPushDelivery({ registrationId: 'phone', hostFingerprint: 'host',
        notification: batch.notifications.at(-1)!, notifications: batch.notifications,
        title: 'Orca', body: 'Updates', coalescedCount: batch.notifications.length })
      expect(Buffer.byteLength(apnsBody(delivery))).toBeLessThanOrEqual(4096)
      expect(Buffer.byteLength(JSON.stringify({ notification: { title: delivery.title, body: delivery.body }, data: orcaDataStrings(delivery.orca) }))).toBeLessThanOrEqual(4096)
      if (batch.notifications.length > 1) {
        expect(delivery.orca.summaryMembers).toHaveLength(batch.notifications.length)
        expect(JSON.parse(orcaDataStrings(delivery.orca).summaryMembers!)).toEqual(delivery.orca.summaryMembers)
      }
      expect(collapseIds.has(delivery.collapseId)).toBe(false)
      collapseIds.add(delivery.collapseId)
      recovered.push(...batch.notifications.map((item) => item.notificationSeq))
      await store.finish(batch)
    }
    expect(recovered.sort((a, b) => a - b)).toEqual(expected.map((item) => item.notificationSeq))
    expect(await store.pendingCount('phone')).toBe(0)
  } finally { await database.close() }
})
it('does not make an untrackable event part of a dismissible summary', () => {
  expect(canCoalescePushNotifications([notification(1), { ...notification(2), notificationId: undefined }], 'host')).toBe(false)
  expect(canCoalescePushNotifications([notification(1), { ...notification(2), kind: 'dismiss' }], 'host')).toBe(false)
})
