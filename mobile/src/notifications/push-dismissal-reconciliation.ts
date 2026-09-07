import * as Notifications from 'expo-notifications'
import type { RpcClient } from '../transport/rpc-client'
import { loadHostCatalog } from '../transport/host-store'
import { resolveHostIdForFingerprint } from './push-host-fingerprint'
import { readNativeNotificationData } from './native-notification-data'
import { readOrcaPushPayload, type OrcaPushPayload } from './push-payload'
import { dismissPresentedPushNotification } from './push-tray-dismissal'

type Identity = { notificationId: string; notificationEpoch: string; notificationSeq: number }
const key = (item: Identity) =>
  JSON.stringify([item.notificationId, item.notificationEpoch, item.notificationSeq])
function identity(value: unknown): Identity | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const item = value as Identity
  return typeof item.notificationId === 'string' &&
    item.notificationId.length > 0 &&
    item.notificationId.length <= 512 &&
    typeof item.notificationEpoch === 'string' &&
    item.notificationEpoch.length > 0 &&
    item.notificationEpoch.length <= 128 &&
    Number.isSafeInteger(item.notificationSeq) &&
    item.notificationSeq >= 0
    ? {
        notificationId: item.notificationId,
        notificationEpoch: item.notificationEpoch,
        notificationSeq: item.notificationSeq
      }
    : null
}
async function readDelivered(hostId: string): Promise<Map<string, OrcaPushPayload>> {
  const selected = new Map<string, OrcaPushPayload>()
  try {
    const [presented, hosts] = await Promise.all([
      Notifications.getPresentedNotificationsAsync(),
      loadHostCatalog()
    ])
    for (const notification of presented) {
      const payload = readOrcaPushPayload(readNativeNotificationData(notification.request))
      const id = identity(payload)
      if (
        !payload ||
        !id ||
        (payload.coalescedCount ?? 0) > 1 ||
        resolveHostIdForFingerprint(payload.hostFingerprint, hosts) !== hostId
      ) {
        continue
      }
      selected.set(key(id), payload)
      if (selected.size === 256) {
        break
      }
    }
  } catch {
    // Legacy shells can still use ordinary event replay without tray inspection.
  }
  return selected
}

export async function requestNotificationCatchup(
  client: Pick<RpcClient, 'sendRequest'>,
  hostId: string,
  params: { lastSeenSeq: number; epoch?: string; includeDesktopSuppressed?: boolean },
  isDisposed: () => boolean
) {
  const delivered = await readDelivered(hostId)
  const response = await client.sendRequest('notifications.getMissedSince', {
    ...params,
    ...(delivered.size
      ? { deliveredPushes: [...delivered.values()].map((payload) => identity(payload)!) }
      : {})
  })
  if (!response.ok || isDisposed()) {
    return response
  }
  const result = response.result as { dismissedPushes?: unknown } | undefined
  // Older hosts ignore the optional request field and return no reconciliation result.
  if (Array.isArray(result?.dismissedPushes)) {
    for (const raw of result.dismissedPushes.slice(0, 256)) {
      if (isDisposed()) {
        break
      }
      const id = identity(raw)
      const payload = id ? delivered.get(key(id)) : undefined
      if (payload && id) {
        await dismissPresentedPushNotification(id.notificationId, payload.hostFingerprint, id)
      }
    }
  }
  return response
}
