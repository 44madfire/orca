import type { PushNotification } from '@orca-cloud/push-contract'

export type PushSummaryMember = {
  notificationId: string
  notificationEpoch: string
  notificationSeq: number
}

export function pushSummaryMembers(
  notifications: readonly PushNotification[]
): PushSummaryMember[] | undefined {
  if (notifications.length < 2 || notifications.length > 32) return undefined
  if (notifications.some((item) => !item.notificationId || item.kind === 'dismiss')) return undefined
  return notifications.map((item) => ({
    notificationId: item.notificationId!,
    notificationEpoch: item.notificationEpoch,
    notificationSeq: item.notificationSeq
  }))
}
