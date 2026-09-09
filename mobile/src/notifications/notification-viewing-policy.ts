import { AppState } from 'react-native'
import { loadNotificationDeliveryPreferences } from './notification-delivery-preferences'

let viewing: { hostId: string; worktreeId: string } | null = null
export function setNotificationViewingWorkspace(value: typeof viewing): void {
  viewing = value
}

export async function shouldSuppressNotificationWhileViewing(
  event: { worktreeId?: string },
  hostId: string
): Promise<boolean> {
  const preferences = await loadNotificationDeliveryPreferences()
  return (
    preferences.suppressWhileViewing &&
    AppState.currentState === 'active' &&
    viewing?.hostId === hostId &&
    viewing.worktreeId === event.worktreeId
  )
}
