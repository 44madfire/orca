import { representedPushes } from './push-summary-members'
import { readNativeNotificationData } from './native-notification-data'
import * as Notifications from 'expo-notifications'
import { readOrcaPushPayload, type OrcaPushPayload } from './push-payload'
import {
  areLegacySummaryPushesDismissed,
  rememberPushDismissal,
  wasPushDismissed
} from './push-dismissal-watermarks'

async function dismissMatchingPresentedPushes(
  matches: (payload: OrcaPushPayload) => boolean | Promise<boolean>
): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync()
    await Promise.all(
      presented.map(async (notification) => {
        const payload = readOrcaPushPayload(readNativeNotificationData(notification.request))
        if (payload && (await matches(payload))) {
          await Notifications.dismissNotificationAsync(notification.request.identifier).catch(
            () => {}
          )
        }
      })
    )
  } catch {
    // Older native shells lack the tray query; local dismissal still runs.
  }
}

export function dismissRememberedPushNotifications(
  hostFingerprint: string,
  confirmed: readonly OrcaPushPayload[] = []
): Promise<void> {
  return dismissMatchingPresentedPushes(async (payload) => {
    if (payload.hostFingerprint !== hostFingerprint) {
      return false
    }
    const members = representedPushes(payload)
    return (
      members.length > 0 &&
      (
        await Promise.all(
          members.map(
            (member) =>
              confirmed.some(
                (fence) =>
                  fence.notificationId === member.notificationId &&
                  fence.notificationEpoch === member.notificationEpoch &&
                  fence.notificationSeq !== undefined &&
                  member.notificationSeq !== undefined &&
                  fence.notificationSeq >= member.notificationSeq
              ) || wasPushDismissed(member)
          )
        )
      ).every(Boolean)
    )
  })
}

// Pushes shown while Orca was closed are absent from the local scheduling registry.
export async function dismissPresentedPushNotification(
  notificationId: string,
  hostFingerprint?: string,
  fence?: { notificationEpoch?: string; notificationSeq?: number }
): Promise<void> {
  if (hostFingerprint && fence) {
    await rememberPushDismissal({ hostFingerprint, notificationId, ...fence })
  }
  await dismissMatchingPresentedPushes((payload) => {
    if (hostFingerprint && payload.hostFingerprint !== hostFingerprint) {
      return false
    }
    if ((payload.coalescedCount ?? 0) > 1) {
      return areLegacySummaryPushesDismissed(payload)
    }
    return (
      payload.notificationId === notificationId &&
      (!fence ||
        Boolean(
          fence.notificationEpoch &&
          fence.notificationSeq !== undefined &&
          payload.notificationEpoch === fence.notificationEpoch &&
          payload.notificationSeq !== undefined &&
          payload.notificationSeq <= fence.notificationSeq
        ))
    )
  })
}
