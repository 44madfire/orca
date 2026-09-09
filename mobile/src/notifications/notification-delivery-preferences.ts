import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  MOBILE_PUSH_AGENT_STATES,
  MOBILE_PUSH_SOURCES,
  type MobilePushFilter
} from '../../../src/shared/mobile-push-contract'

const KEY = 'orca:notificationDeliveryPreferences'
export type NotificationDeliveryPreferences = {
  onlyWhenDesktopAway: boolean
  sound: boolean
  suppressWhileViewing: boolean
}

export const DEFAULT_NOTIFICATION_DELIVERY: NotificationDeliveryPreferences = {
  onlyWhenDesktopAway: true,
  sound: true,
  suppressWhileViewing: true
}

export async function loadNotificationDeliveryPreferences(): Promise<NotificationDeliveryPreferences> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    if (!raw) {
      return { ...DEFAULT_NOTIFICATION_DELIVERY }
    }
    const stored = JSON.parse(raw) as Record<string, unknown>
    const result = { ...DEFAULT_NOTIFICATION_DELIVERY }
    for (const key of Object.keys(result) as (keyof NotificationDeliveryPreferences)[]) {
      if (typeof stored?.[key] === 'boolean') {
        result[key] = stored[key]
      }
    }
    return result
  } catch {
    return { ...DEFAULT_NOTIFICATION_DELIVERY }
  }
}

export async function saveNotificationDeliveryPreferences(
  value: NotificationDeliveryPreferences
): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(value))
}

export function notificationPreferencesFilter(
  value: NotificationDeliveryPreferences
): MobilePushFilter {
  return {
    onlyWhenDesktopAway: value.onlyWhenDesktopAway,
    expireAfterInactivity: true,
    followDesktop: true,
    sound: value.sound,
    sources: MOBILE_PUSH_SOURCES,
    agentStates: MOBILE_PUSH_AGENT_STATES
  }
}
