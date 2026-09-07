import { loadHostCatalog } from '../transport/host-store'
import { deriveHostFingerprint } from './push-host-fingerprint'
import { dismissPresentedPushNotification } from './push-tray-dismissal'
import type { DismissNotificationEvent } from './local-notification-scheduling'

export async function dismissHostPushNotification(
  event: DismissNotificationEvent,
  hostId: string
): Promise<void> {
  const hosts = await loadHostCatalog().catch(() => [])
  const host = hosts.find((item) => item.id === hostId)
  const fingerprint = host ? deriveHostFingerprint(host.publicKeyB64) : null
  if (!fingerprint) {
    return
  }
  await dismissPresentedPushNotification(event.notificationId, fingerprint, event)
}
