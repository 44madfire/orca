import type { PushNotification } from '@orca-cloud/push-contract'
import type { PushDatabase } from './push-database.js'

export async function reconcileQueuedDismissal(
  tx: PushDatabase,
  host: string,
  registrationId: string,
  notification: PushNotification,
  now: number
): Promise<boolean> {
  if (!notification.notificationId) return false
  const key = [host, notification.notificationEpoch, notification.notificationId]
  const [dismissed] = await tx.query(
    'SELECT notification_seq FROM push_dismissed_events WHERE host_fingerprint = ? AND notification_epoch = ? AND notification_id = ?',
    key
  )
  if (notification.kind !== 'dismiss')
    return Number(dismissed?.notification_seq ?? -1) > notification.notificationSeq
  await tx.query(
    `INSERT INTO push_dismissed_events(host_fingerprint, notification_epoch, notification_id, notification_seq, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(host_fingerprint, notification_epoch, notification_id)
    DO UPDATE SET notification_seq = CASE WHEN push_dismissed_events.notification_seq > excluded.notification_seq THEN push_dismissed_events.notification_seq ELSE excluded.notification_seq END, created_at = excluded.created_at`,
    [...key, notification.notificationSeq, now]
  )
  const batches = await tx.query(
    "SELECT batch_id, payload_json FROM push_delivery_batches WHERE registration_id = ? AND kind = 'alert' AND state = 'pending' AND lease_until <= ?",
    [registrationId, now]
  )
  for (const batch of batches) {
    const previous = JSON.parse(String(batch.payload_json)) as PushNotification[]
    const remaining = previous.filter(
      (item) =>
        item.notificationEpoch !== notification.notificationEpoch ||
        item.notificationId !== notification.notificationId ||
        item.notificationSeq > notification.notificationSeq
    )
    if (remaining.length === previous.length) continue
    await tx.query(
      'UPDATE push_delivery_batches SET payload_json = ?, state = ? WHERE batch_id = ?',
      [JSON.stringify(remaining), remaining.length ? 'pending' : 'dismissed', batch.batch_id]
    )
  }
  return false
}

export async function removeDismissedAlerts(
  tx: PushDatabase,
  host: string,
  notifications: PushNotification[]
): Promise<PushNotification[]> {
  const ids = [
    ...new Set(
      notifications
        .filter((item) => item.kind !== 'dismiss' && item.notificationId)
        .map((item) => item.notificationId!)
    )
  ]
  if (!ids.length) return notifications
  const rows = await tx.query(
    `SELECT notification_epoch, notification_id, notification_seq FROM push_dismissed_events
    WHERE host_fingerprint = ? AND notification_id IN (${ids.map(() => '?').join(',')})`,
    [host, ...ids]
  )
  const dismissed = new Map(
    rows.map((row) => [
      JSON.stringify([row.notification_epoch, row.notification_id]),
      Number(row.notification_seq)
    ])
  )
  return notifications.filter(
    (item) =>
      item.kind === 'dismiss' ||
      (dismissed.get(JSON.stringify([item.notificationEpoch, item.notificationId])) ?? -1) <
        item.notificationSeq
  )
}
