import { reserveNotificationCooldown } from '../../../src/shared/notification-burst-cooldown'
import { loadNotificationDeliveryPreferences } from './notification-delivery-preferences'
import { allowsLocalNotification } from './notification-viewing-policy'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { DESKTOP_NOTIFICATION_CHANNEL_ID } from './desktop-notification-channel'
import { buildLocalNotificationData, type DesktopNotificationSource } from './notification-routing'
import { ensureNotificationPermissions } from './notification-permissions'
import { dismissHostPushNotification, wasHostPushDismissed } from './push-socket-dismissal'

export type NotificationEvent = {
  type: 'notification'
  desktopAllowed?: boolean
  desktopAway?: boolean
  emittedAt?: number
  agentState?: string
  source: DesktopNotificationSource
  title: string
  body: string
  worktreeId?: string
  notificationId?: string
  // Desktop-assigned seq for reconnect catch-up (#8129); optional since older runtimes may omit it.
  notificationSeq?: number
  // Counter lifetime the seq belongs to (#8591); absent on older runtimes.
  notificationEpoch?: string
}

export type DismissNotificationEvent = {
  type: 'dismiss'
  notificationId: string
  notificationSeq?: number
  notificationEpoch?: string
}

type ScheduledNotificationState = {
  event?: NotificationEvent
  identifier?: string
  pending?: Promise<string | null>
  dismissAfterSchedule?: boolean
}

const recentNotifications = new Map<string, number>()

function reserveLocalNotification(event: NotificationEvent, hostId: string): boolean {
  return (
    event.emittedAt === undefined ||
    reserveNotificationCooldown(
      recentNotifications,
      JSON.stringify([hostId, event.worktreeId ?? 'global']),
      event.emittedAt
    )
  )
}

function releaseLocalNotification(event: NotificationEvent, hostId: string): void {
  const key = JSON.stringify([hostId, event.worktreeId ?? 'global'])
  if (event.emittedAt !== undefined && recentNotifications.get(key) === event.emittedAt) {
    recentNotifications.delete(key)
  }
}

const scheduledNotificationsByHostAndNotificationId = new Map<string, ScheduledNotificationState>()

// Why: keys never repeat and are only freed on desktop dismiss (which remote users often miss), so bound the map to stop unbounded growth.
const MAX_SCHEDULED_NOTIFICATIONS = 256
let maxScheduledNotifications = MAX_SCHEDULED_NOTIFICATIONS

function getStoredNotificationKey(hostId: string, notificationId: string): string {
  return `${encodeURIComponent(hostId)}:${encodeURIComponent(notificationId)}`
}

// Evict oldest settled entries (never mid-schedule); Map iteration is insertion order so the first match is oldest.
function boundScheduledNotifications(): void {
  while (scheduledNotificationsByHostAndNotificationId.size > maxScheduledNotifications) {
    let evicted = false
    for (const [key, state] of scheduledNotificationsByHostAndNotificationId) {
      if (!state.pending) {
        scheduledNotificationsByHostAndNotificationId.delete(key)
        evicted = true
        break
      }
    }
    if (!evicted) {
      break
    }
  }
}

/** Test-only: override the cap (pass no arg to restore the default). */
export function setScheduledNotificationsMaxForTests(max?: number): void {
  maxScheduledNotifications = max ?? MAX_SCHEDULED_NOTIFICATIONS
}

export async function showLocalNotification(
  event: NotificationEvent,
  hostId: string
): Promise<void> {
  if (!(await allowsLocalNotification(event, hostId))) {
    return
  }
  const preferences = await loadNotificationDeliveryPreferences()
  const channelId = preferences.sound
    ? DESKTOP_NOTIFICATION_CHANNEL_ID
    : `${DESKTOP_NOTIFICATION_CHANNEL_ID}-silent`
  const storedKey = event.notificationId
    ? getStoredNotificationKey(hostId, event.notificationId)
    : null

  if (!storedKey) {
    const enabled = await loadPushNotificationsEnabled()
    if (!enabled) {
      return
    }

    const granted = await ensureNotificationPermissions()
    if (!granted) {
      return
    }

    if (!reserveLocalNotification(event, hostId)) {
      return
    }
    await Notifications.scheduleNotificationAsync({
      content: {
        title: event.title,
        body: event.body,
        sound: preferences.sound ? 'default' : false,
        data: buildLocalNotificationData(event, hostId)
      },
      trigger: Platform.OS === 'android' ? { channelId } : null
    })
    return
  }

  let state = scheduledNotificationsByHostAndNotificationId.get(storedKey)
  if (state?.pending) {
    return
  }
  if (!state) {
    state = {}
    scheduledNotificationsByHostAndNotificationId.set(storedKey, state)
  }
  const notificationState = state
  notificationState.event = event
  let reserved = false
  let scheduled = false

  const pending = (async () => {
    const enabled = await loadPushNotificationsEnabled()
    if (!enabled) {
      return null
    }

    const granted = await ensureNotificationPermissions()
    if (!granted) {
      return null
    }

    if ((await wasHostPushDismissed(event, hostId)) || notificationState.dismissAfterSchedule) {
      return null
    }
    reserved = reserveLocalNotification(event, hostId)
    if (!reserved) {
      return null
    }
    if (notificationState.identifier) {
      await Notifications.dismissNotificationAsync(notificationState.identifier).catch(() => {})
      notificationState.identifier = undefined
      if ((await wasHostPushDismissed(event, hostId)) || notificationState.dismissAfterSchedule) {
        return null
      }
    }
    return Notifications.scheduleNotificationAsync({
      content: {
        title: event.title,
        body: event.body,
        sound: preferences.sound ? 'default' : false,
        data: buildLocalNotificationData(event, hostId)
      },
      trigger: Platform.OS === 'android' ? { channelId } : null
    })
  })()
  notificationState.pending = pending

  try {
    const scheduledIdentifier = await pending
    if (!scheduledIdentifier) {
      if (!notificationState.identifier) {
        scheduledNotificationsByHostAndNotificationId.delete(storedKey)
      }
      return
    }
    scheduled = true
    const dismissed = await wasHostPushDismissed(event, hostId)
    if (dismissed || notificationState.dismissAfterSchedule) {
      notificationState.dismissAfterSchedule = false
      scheduledNotificationsByHostAndNotificationId.delete(storedKey)
      await Notifications.dismissNotificationAsync(scheduledIdentifier).catch(() => {})
      return
    }
    notificationState.identifier = scheduledIdentifier
    boundScheduledNotifications()
  } finally {
    // Only roll back this attempt; another notification may own a newer reservation.
    if (reserved && !scheduled) {
      releaseLocalNotification(event, hostId)
    }
    if (notificationState.pending === pending) {
      notificationState.pending = undefined
      notificationState.dismissAfterSchedule = false
    }
  }
}

export async function dismissLocalNotification(
  event: DismissNotificationEvent,
  hostId: string
): Promise<void> {
  if (!event.notificationId) {
    return
  }
  // Why first and unconditionally: a push the OS presented while Orca was closed has
  // no entry below, so the local registry alone would leave it in the tray forever.
  await dismissHostPushNotification(event, hostId)
  const storedKey = getStoredNotificationKey(hostId, event.notificationId)
  const state = scheduledNotificationsByHostAndNotificationId.get(storedKey)
  if (!state) {
    return
  }
  if (
    event.notificationEpoch &&
    event.notificationSeq !== undefined &&
    state.event?.notificationEpoch &&
    state.event.notificationSeq !== undefined &&
    (state.event.notificationEpoch !== event.notificationEpoch ||
      state.event.notificationSeq > event.notificationSeq)
  ) {
    return
  }
  if (state.pending) {
    // Why: dismiss can arrive while the OS is still scheduling; defer it so no stale banner survives.
    state.dismissAfterSchedule = true
    return
  }
  if (!state.identifier) {
    return
  }
  scheduledNotificationsByHostAndNotificationId.delete(storedKey)
  await Notifications.dismissNotificationAsync(state.identifier).catch(() => {})
}
