import { beforeEach, expect, it, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { nativePushDismissal } from './native-push-dismissal'
import { rememberPushDismissal, wasPushDismissed } from './push-dismissal-watermarks'
import { foregroundNotificationBehavior, shouldSuppressForegroundPush } from './push-receive'
import { loadNotificationDeliveryPreferences } from './notification-delivery-preferences'

const memory = vi.hoisted(() => new Map<string, string>())
const nativeLedger = vi.hoisted(() => new Map<string, number>())
vi.mock('./native-push-dismissal', () => ({
  nativePushDismissal: {
    remember: vi.fn(async (payload) => {
      const key = JSON.stringify([
        payload.hostFingerprint,
        payload.notificationEpoch,
        payload.notificationId
      ])
      nativeLedger.set(key, Math.max(nativeLedger.get(key) ?? 0, payload.notificationSeq))
    }),
    wasDismissed: vi.fn(
      async (payload) =>
        (nativeLedger.get(
          JSON.stringify([
            payload.hostFingerprint,
            payload.notificationEpoch,
            payload.notificationId
          ])
        ) ?? -1) >= payload.notificationSeq
    )
  }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => memory.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      memory.set(key, value)
    })
  }
}))
vi.mock('expo-notifications', () => ({ getPresentedNotificationsAsync: async () => [] }))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: async () => [{ id: 'host' }] }))
vi.mock('./push-host-fingerprint', () => ({ resolveHostIdForFingerprint: () => 'host' }))
vi.mock('../storage/preferences', () => ({
  loadPushNotificationsEnabled: async () => true,
  loadRemotePushEnabled: async () => true
}))
vi.mock('./notification-viewing-policy', () => ({
  shouldSuppressNotificationWhileViewing: async () => false
}))
vi.mock('./notification-delivery-preferences', () => ({
  loadNotificationDeliveryPreferences: vi.fn(async () => ({ sound: true }))
}))

const payload = {
  hostFingerprint: 'abcdefghijklmnop',
  notificationEpoch: 'epoch',
  notificationId: 'note',
  notificationSeq: 20
}
const fence = { ...payload, notificationSeq: 21 }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => memory.get(key) ?? null)
  memory.clear()
  nativeLedger.clear()
})

it('suppresses a foreground push dismissed natively during its queued fallback read', async () => {
  let finish!: () => void
  let reads = 0
  vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => {
    if (key === 'orca:pushDismissalWatermarks:v1' && ++reads === 1) {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    }
    return memory.get(key) ?? null
  })
  const pending = shouldSuppressForegroundPush({ orca: payload })
  await vi.waitFor(() => expect(finish).toBeDefined())
  await shouldSuppressForegroundPush({ orca: { ...fence, kind: 'dismiss' } })
  expect(memory.has('orca:pushDismissalWatermarks:v1')).toBe(false)
  finish()
  expect(await pending).toBe(true)
})

it.each(['native', 'fallback'])(
  'rechecks a negative native snapshot overtaken by a %s dismissal',
  async (backend) => {
    let finish!: () => void
    vi.mocked(nativePushDismissal!.wasDismissed).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return false
    })
    const pending = wasPushDismissed(payload)
    await vi.waitFor(() => expect(finish).toBeDefined())
    if (backend === 'fallback') {
      vi.mocked(nativePushDismissal!.remember).mockRejectedValueOnce(
        new Error('bridge unavailable')
      )
    }
    await rememberPushDismissal(fence)
    finish()
    expect(await pending).toBe(true)
    expect(nativePushDismissal!.wasDismissed).toHaveBeenCalledTimes(backend === 'native' ? 2 : 1)
  }
)

it('retains fallback dismissals when the native bridge recovers', async () => {
  vi.mocked(nativePushDismissal!.remember).mockRejectedValueOnce(new Error('bridge unavailable'))
  await rememberPushDismissal(fence)
  expect(nativeLedger.size).toBe(0)
  expect(await wasPushDismissed(payload)).toBe(true)
  expect(await wasPushDismissed({ ...payload, notificationSeq: 22 })).toBe(false)
  expect(await wasPushDismissed({ ...payload, notificationEpoch: 'new-epoch' })).toBe(false)
})

it('suppresses presentation when dismissal completes during the handler sound read', async () => {
  let finish!: () => void
  vi.mocked(loadNotificationDeliveryPreferences).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { sound: true } as Awaited<ReturnType<typeof loadNotificationDeliveryPreferences>>
  })
  const pending = foregroundNotificationBehavior({
    request: {
      identifier: 'foreground-alert',
      trigger: null,
      content: { title: null, subtitle: null, body: null, sound: null, data: { orca: payload } }
    }
  })
  await vi.waitFor(() => expect(finish).toBeDefined())
  await shouldSuppressForegroundPush({ orca: { ...fence, kind: 'dismiss' } })
  expect(await wasPushDismissed(payload)).toBe(true)
  finish()
  expect(await pending).toEqual({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false
  })
})
