const memory = vi.hoisted(() => new Map<string, string>())
import { beforeEach, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import {
  dismissLocalNotification,
  showLocalNotification,
  type NotificationEvent
} from './local-notification-scheduling'
import { allowsLocalNotification } from './notification-viewing-policy'
import { loadNotificationDeliveryPreferences } from './notification-delivery-preferences'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { Platform } from 'react-native'
import { shouldSuppressForegroundPush } from './push-receive'
vi.mock('react-native', () => ({ AppState: { currentState: 'active' }, Platform: { OS: 'ios' } }))
vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: vi.fn(async () => []),
  getPermissionsAsync: vi.fn(async () => ({ status: 'granted', canAskAgain: true })),
  scheduleNotificationAsync: vi.fn(async () => 'local'),
  dismissNotificationAsync: vi.fn(async () => {})
}))
vi.mock('../transport/host-store', () => ({
  loadHostCatalog: vi.fn(async () =>
    [
      'host',
      'host-policy',
      'host-preferences',
      'host-permission',
      'host-enabled',
      'host-replacement',
      'host-newer-epoch',
      'host-newer-new-epoch',
      'host-channel'
    ].map((id) => ({ id }))
  )
}))
vi.mock('./push-host-fingerprint', () => ({
  resolveHostIdForFingerprint: () => 'host',
  deriveHostFingerprint: () => 'abcdefghijklmnop'
}))
vi.mock('../storage/preferences', () => ({
  loadRemotePushEnabled: async () => true,
  loadPushNotificationsEnabled: vi.fn(async () => true),
  loadRemotePushHostRegistrations: async () => ({ registeredHostIds: ['host'] })
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => memory.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      memory.set(key, value)
    }
  }
}))

vi.mock('./notification-viewing-policy', () => ({
  allowsLocalNotification: vi.fn(async () => true)
}))
vi.mock('./notification-delivery-preferences', () => ({
  loadNotificationDeliveryPreferences: vi.fn(async () => ({ sound: true }))
}))
const event: NotificationEvent = {
  type: 'notification',
  source: 'agent-task-complete',
  title: 'Done',
  body: '',
  notificationId: 'lifetime',
  notificationSeq: 20,
  notificationEpoch: 'epoch'
}
const dismiss = {
  type: 'dismiss' as const,
  notificationId: 'lifetime',
  notificationSeq: 21,
  notificationEpoch: 'epoch'
}
beforeEach(() => {
  vi.clearAllMocks()
  memory.clear()
  Platform.OS = 'ios'
})

it.each(['policy', 'preferences', 'enabled', 'permission'] as const)(
  'honors dismissal during %s before scheduling',
  async (stage) => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const entered = vi.fn()
    if (stage === 'policy') {
      vi.mocked(allowsLocalNotification).mockImplementationOnce(async () => {
        entered()
        await gate
        return true
      })
    } else if (stage === 'preferences') {
      vi.mocked(loadNotificationDeliveryPreferences).mockImplementationOnce(async () => {
        entered()
        await gate
        return { sound: true } as never
      })
    } else if (stage === 'enabled') {
      vi.mocked(loadPushNotificationsEnabled).mockImplementationOnce(async () => {
        entered()
        await gate
        return true
      })
    } else {
      vi.mocked(Notifications.getPermissionsAsync).mockImplementationOnce(async () => {
        entered()
        await gate
        return { status: 'granted' } as never
      })
    }
    const timedEvent = { ...event, emittedAt: 100000 }
    const pending = showLocalNotification(timedEvent, `host-${stage}`)
    await vi.waitFor(() => expect(entered).toHaveBeenCalled())
    await dismissLocalNotification(dismiss, `host-${stage}`)
    finish()
    await pending
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled()
    await showLocalNotification(
      { ...timedEvent, notificationSeq: 22, emittedAt: 100001 },
      `host-${stage}`
    )
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledOnce()
  }
)

it('cleans up a push dismissal that completes while native scheduling is pending', async () => {
  let finish!: (id: string) => void
  vi.mocked(Notifications.scheduleNotificationAsync).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = showLocalNotification(event, 'host')
  await vi.waitFor(() => expect(finish).toBeDefined())
  await shouldSuppressForegroundPush({
    orca: { ...dismiss, kind: 'dismiss', hostFingerprint: 'abcdefghijklmnop' }
  })
  finish('late-native')
  await pending
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('late-native')
})

it.each([
  ['epoch', 22],
  ['new-epoch', 1]
] as const)(
  'preserves newer same-ID alert %s/%s during and after scheduling',
  async (notificationEpoch, notificationSeq) => {
    let finish!: (id: string) => void
    vi.mocked(Notifications.scheduleNotificationAsync).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = showLocalNotification(
      { ...event, notificationEpoch, notificationSeq },
      `host-newer-${notificationEpoch}`
    )
    await vi.waitFor(() => expect(finish).toBeDefined())
    await dismissLocalNotification(dismiss, `host-newer-${notificationEpoch}`)
    finish('newer-native')
    await pending
    await dismissLocalNotification(dismiss, `host-newer-${notificationEpoch}`)
    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalledWith('newer-native')
  }
)

it.each([
  [true, 'channel-id'],
  [false, 'channel-id'],
  [true, undefined],
  [false, undefined]
])('selects Android channel in the trigger (sound=%s, id=%s)', async (sound, notificationId) => {
  Platform.OS = 'android'
  vi.mocked(loadNotificationDeliveryPreferences).mockResolvedValueOnce({ sound } as never)
  await showLocalNotification(
    { ...event, notificationId: notificationId as string | undefined },
    'host-channel'
  )
  const request = vi.mocked(Notifications.scheduleNotificationAsync).mock.calls[0][0]
  expect(request.trigger).toEqual({ channelId: sound ? 'orca-desktop' : 'orca-desktop-silent' })
  expect(request.content).not.toHaveProperty('channelId')
  expect(request.content.sound).toBe(sound ? 'default' : false)
})

it('honors dismissal while awaiting removal of a previous local banner', async () => {
  await showLocalNotification(
    { ...event, notificationSeq: 19, emittedAt: 90000 },
    'host-replacement'
  )
  expect(vi.mocked(Notifications.scheduleNotificationAsync).mock.calls[0][0].trigger).toBeNull()
  let finish!: () => void
  vi.mocked(Notifications.dismissNotificationAsync).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = showLocalNotification({ ...event, emittedAt: 100000 }, 'host-replacement')
  await vi.waitFor(() => expect(finish).toBeDefined())
  await dismissLocalNotification(dismiss, 'host-replacement')
  finish()
  await pending
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledOnce()
  await showLocalNotification(
    { ...event, notificationSeq: 22, emittedAt: 100001 },
    'host-replacement'
  )
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2)
})

it('releases cooldown for an identified notification whose native schedule fails', async () => {
  const retryEvent = { ...event, notificationId: 'retry', worktreeId: 'retry', emittedAt: 100000 }
  vi.mocked(Notifications.scheduleNotificationAsync).mockRejectedValueOnce(
    new Error('native failed')
  )
  await expect(showLocalNotification(retryEvent, 'host')).rejects.toThrow('native failed')
  await showLocalNotification(retryEvent, 'host')
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2)
})

it('does not release a newer concurrent notification cooldown when an older schedule fails', async () => {
  const older = {
    ...event,
    notificationId: 'older-failure',
    worktreeId: 'overlap',
    emittedAt: 100000
  }
  let fail!: (error: Error) => void
  vi.mocked(Notifications.scheduleNotificationAsync).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
  )
  const pending = showLocalNotification(older, 'host').catch((error) => error)
  await vi.waitFor(() => expect(fail).toBeDefined())
  await showLocalNotification(
    { ...older, notificationId: 'newer-success', emittedAt: 106000 },
    'host'
  )
  fail(new Error('native failed'))
  expect(await pending).toBeInstanceOf(Error)
  await showLocalNotification(
    { ...older, notificationId: 'within-newer-cooldown', emittedAt: 106001 },
    'host'
  )
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2)
})
