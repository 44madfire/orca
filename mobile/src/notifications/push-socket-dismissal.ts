import { wasPushDismissed } from './push-dismissal-watermarks'
import { loadHostCatalog } from '../transport/host-store'
import { deriveHostFingerprint } from './push-host-fingerprint'
import { dismissPresentedPushNotification } from './push-tray-dismissal'
import type { DismissNotificationEvent } from './local-notification-scheduling'

async function hostFingerprint(hostId: string): Promise<string | null> {
  const hosts = await loadHostCatalog().catch(() => [])
  const host = hosts.find((item) => item.id === hostId)
  return host ? deriveHostFingerprint(host.publicKeyB64) : null
}

export async function wasHostPushDismissed(
  event: { notificationId?: string; notificationEpoch?: string; notificationSeq?: number },
  hostId: string
): Promise<boolean> {
  const fingerprint = await hostFingerprint(hostId)
  return fingerprint ? wasPushDismissed({ ...event, hostFingerprint: fingerprint }) : false
}

export async function dismissHostPushNotification(
  event: DismissNotificationEvent,
  hostId: string
): Promise<void> {
  const fingerprint = await hostFingerprint(hostId)
  if (!fingerprint) {
    return
  }
  const fence = event.notificationEpoch && event.notificationSeq !== undefined ? event : undefined
  await dismissPresentedPushNotification(event.notificationId, fingerprint, fence)
}
