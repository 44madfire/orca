import { readNativeNotificationData } from './native-notification-data'
import * as Notifications from 'expo-notifications'
import { readOrcaPushPayload } from './push-payload'
import { rememberPushDismissal } from './push-dismissal-watermarks'

// Pushes shown while Orca was closed are absent from the local scheduling registry.
export async function dismissPresentedPushNotification(
  notificationId: string,
  hostFingerprint?: string,
  fence?: { notificationEpoch?: string; notificationSeq?: number }
): Promise<void> {
  if (hostFingerprint && fence) {
    await rememberPushDismissal({ hostFingerprint, notificationId, ...fence })
  }
  try {
    const presented = await Notifications.getPresentedNotificationsAsync()
    await Promise.all(
      presented.map(async (notification) => {
        const payload = readOrcaPushPayload(readNativeNotificationData(notification.request))
        if (
          payload?.notificationId !== notificationId ||
          (payload.coalescedCount ?? 0) > 1 ||
          (hostFingerprint && payload.hostFingerprint !== hostFingerprint) ||
          (fence &&
            (!fence.notificationEpoch ||
              fence.notificationSeq === undefined ||
              payload.notificationEpoch !== fence.notificationEpoch ||
              payload.notificationSeq === undefined ||
              payload.notificationSeq > fence.notificationSeq))
        ) {
          return
        }
        await Notifications.dismissNotificationAsync(notification.request.identifier).catch(
          () => {}
        )
      })
    )
  } catch {
    // Older native shells lack the tray query; local dismissal still runs.
  }
}
