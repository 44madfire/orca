import { createHash } from 'node:crypto'
import { type PushNotification } from '@orca-cloud/push-contract'
import { pushSummaryMembers, type PushSummaryMember } from './push-summary-members.js'

export type PushOrcaData = {
  kind?: 'alert' | 'dismiss'
  hostFingerprint: string
  worktreeId?: string
  notificationId?: string
  notificationSeq: number
  notificationEpoch: string
  source: string
  agentState: string | null
  coalescedCount: number
  summaryMembers?: PushSummaryMember[]
}

export type PushDelivery = {
  expiresAt?: number
  sound?: boolean
  registrationId: string
  hostFingerprint: string
  title: string
  body: string
  collapseId: string
  orca: PushOrcaData
}

export function hostCollapseId(hostFingerprint: string): string {
  return `host:${hostFingerprint}`
}

// APNs rejects a collapse id over 64 bytes, and notification ids are opaque
// desktop strings that may be longer or carry multi-byte characters.
export function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.byteLength <= maxBytes) return value
  let end = maxBytes
  // Walk back off a continuation byte so the cut never splits a code point.
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1
  return encoded.subarray(0, end).toString('utf8')
}

export function collapseIdFor(
  notification: PushNotification,
  hostFingerprint: string,
  coalescedCount: number
): string {
  if (coalescedCount > 1 || notification.notificationId === undefined) {
    return hostCollapseId(hostFingerprint)
  }
  return createHash('sha256')
    .update(JSON.stringify([hostFingerprint, notification.notificationId]))
    .digest('hex')
}

export function buildPushDelivery(input: {
  registrationId: string
  hostFingerprint: string
  notification: PushNotification
  title: string
  body: string
  coalescedCount: number
  notifications?: readonly PushNotification[]
}): PushDelivery {
  const { notification, hostFingerprint, coalescedCount } = input
  const summaryMembers = input.notifications ? pushSummaryMembers(input.notifications) : undefined
  return {
    ...(notification.sound === false ? { sound: false } : {}),
    registrationId: input.registrationId,
    hostFingerprint,
    title: input.title,
    body: input.body,
    collapseId: summaryMembers
      ? createHash('sha256').update(JSON.stringify([hostFingerprint, summaryMembers])).digest('hex')
      : collapseIdFor(notification, hostFingerprint, coalescedCount),
    orca: {
      ...(notification.kind ? { kind: notification.kind } : {}),
      hostFingerprint,
      ...(notification.worktreeId === undefined ? {} : { worktreeId: notification.worktreeId }),
      ...(notification.notificationId === undefined
        ? {}
        : { notificationId: notification.notificationId }),
      notificationSeq: notification.notificationSeq,
      notificationEpoch: notification.notificationEpoch,
      source: notification.source,
      agentState: notification.agentState,
      coalescedCount,
      ...(summaryMembers ? { summaryMembers } : {})
    }
  }
}

export function orcaDataStrings(orca: PushOrcaData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(orca)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)])
  )
}

export function canCoalescePushNotifications(
  notifications: readonly PushNotification[],
  hostFingerprint: string
): boolean {
  if (!pushSummaryMembers(notifications)) return false
  const delivery = buildPushDelivery({
    registrationId: '', hostFingerprint, notifications,
    notification: notifications.at(-1)!, title: 'Orca', body: '32 agents need attention',
    coalescedCount: notifications.length
  })
  // Reserve provider envelope space, including FCM's JSON-string escaping.
  return Buffer.byteLength(JSON.stringify({
    notification: { title: delivery.title, body: delivery.body },
    data: orcaDataStrings(delivery.orca)
  }), 'utf8') <= 3500
}
