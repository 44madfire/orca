import * as Notifications from 'expo-notifications'
import type { RpcClient } from '../transport/rpc-client'
import { loadHostCatalog } from '../transport/host-store'
import { resolveHostIdForFingerprint } from './push-host-fingerprint'
import { readNativeNotificationData } from './native-notification-data'
import { readOrcaPushPayload, type OrcaPushPayload } from './push-payload'
import { dismissRememberedPushNotifications } from './push-tray-dismissal'
import { rememberPushDismissal } from './push-dismissal-watermarks'
import {
  readPushNotificationIdentity,
  type PushNotificationIdentity
} from './push-notification-identity'

const key = (item: PushNotificationIdentity) =>
  JSON.stringify([item.notificationId, item.notificationEpoch, item.notificationSeq])
async function readDelivered(hostId: string): Promise<Map<string, OrcaPushPayload>> {
  const selected = new Map<string, OrcaPushPayload>()
  try {
    const [presented, hosts] = await Promise.all([
      Notifications.getPresentedNotificationsAsync(),
      loadHostCatalog()
    ])
    for (const notification of presented) {
      const payload = readOrcaPushPayload(readNativeNotificationData(notification.request))
      if (!payload || resolveHostIdForFingerprint(payload.hostFingerprint, hosts) !== hostId) {
        continue
      }
      const identity = readPushNotificationIdentity(payload)
      if (identity && selected.size < 2048) {
        selected.set(key(identity), payload)
      }
      if (selected.size === 2048) {
        break
      }
    }
  } catch {
    // Tray inspection is best-effort; failure leaves OS banners for later reconciliation.
  }
  return selected
}

export async function requestNotificationCatchup(
  client: Pick<RpcClient, 'sendRequest'>,
  hostId: string,
  params: { lastSeenSeq: number; epoch?: string; includeDesktopSuppressed?: boolean } | undefined,
  isDisposed: () => boolean
) {
  const delivered = await readDelivered(hostId)
  if (!params && (delivered.size === 0 || isDisposed())) {
    return { ok: true, result: { notifications: [] } }
  }
  const entries = [...delivered.entries()]
  const response = await client.sendRequest('notifications.getMissedSince', {
    // First pairing reconciles tray identities without requesting historical events.
    ...(params ?? { lastSeenSeq: Number.MAX_SAFE_INTEGER }),
    ...(delivered.size
      ? {
          deliveredPushes: entries
            .slice(0, 256)
            .map(([, payload]) => readPushNotificationIdentity(payload)!)
        }
      : {})
  })
  if (!response.ok || isDisposed()) {
    return response
  }
  async function applyDismissals(reply: typeof response, requested: Map<string, OrcaPushPayload>) {
    if (!reply.ok) {
      return
    }
    const result = reply.result as { dismissedPushes?: unknown } | undefined
    if (!Array.isArray(result?.dismissedPushes)) {
      return
    }
    const confirmed: OrcaPushPayload[] = []
    for (const raw of result.dismissedPushes.slice(0, 256)) {
      if (isDisposed()) {
        break
      }
      const id = readPushNotificationIdentity(raw)
      const payload = id ? requested.get(key(id)) : undefined
      if (payload && id) {
        await rememberPushDismissal(payload)
        confirmed.push(payload)
        requested.delete(key(id))
      }
    }
    if (confirmed.length && !isDisposed()) {
      await dismissRememberedPushNotifications(confirmed[0]!.hostFingerprint, confirmed)
    }
  }
  await applyDismissals(response, new Map(entries.slice(0, 256)))
  // Page remaining tray identities without requesting historical events again.
  for (let offset = 256; offset < entries.length && !isDisposed(); offset += 256) {
    const requested = new Map(entries.slice(offset, offset + 256))
    try {
      const reply = await client.sendRequest('notifications.getMissedSince', {
        lastSeenSeq: Number.MAX_SAFE_INTEGER,
        deliveredPushes: [...requested.values()].map((payload) =>
          readPushNotificationIdentity(payload)!
        )
      })
      await applyDismissals(reply, requested)
    } catch {
      break
    }
  }
  return response
}
