import { unregisterPushForRemovedHost } from '../notifications/push-registration'
import { removeHost } from './host-store'

export async function removeHostAndCloseClient(
  hostId: string,
  forgetHostClient: (hostId: string) => void
): Promise<void> {
  // Why before removeHost: the unregister needs the still-authenticated client, and
  // the desktop's own revoke path covers the case where this call cannot land.
  await unregisterPushForRemovedHost(hostId).catch(() => {})
  // Why: closing before the metadata commit can strand a still-paired host on
  // storage failure; closing immediately after success prevents socket leaks.
  await removeHost(hostId)
  forgetHostClient(hostId)
}
