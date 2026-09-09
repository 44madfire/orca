import { ensureDesktopNotificationChannel } from './desktop-notification-channel'
vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: vi.fn(async () => {})
}))
import { beforeEach, expect, it, vi } from 'vitest'
import {
  attachPushRegistration,
  resetPushRegistrationForTests,
  setRemotePushEnabled,
  unregisterPushForRemovedHost,
  NOTIFICATIONS_REMOTE_PUSH_CAPABILITY
} from './push-registration'
import { getDevicePushToken } from './push-token'
import type { MobilePushToken } from './push-token'

const storage = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value)
    }
  }
}))
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }))
vi.mock('./push-token', () => ({ getDevicePushToken: vi.fn(), addPushTokenListener: vi.fn() }))
const token: MobilePushToken = {
  platform: 'ios',
  token: 'a'.repeat(64),
  apnsEnvironment: 'sandbox'
}
const records = () => JSON.parse(storage.get('orca:remotePushHostRegistrations') ?? '{}')
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function client(
  register: () => Promise<unknown> = async () => ({ ok: true, result: { registered: true } })
) {
  return {
    sendRequest: vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return { ok: true, result: { capabilities: [NOTIFICATIONS_REMOTE_PUSH_CAPABILITY] } }
      }
      if (method === 'notifications.registerPush') {
        return register()
      }
      return { ok: true, result: { unregistered: true } }
    })
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  resetPushRegistrationForTests()
  storage.clear()
  storage.set('orca:pushNotificationsEnabled', 'true')
  vi.mocked(getDevicePushToken).mockResolvedValue(token)
})

it('does not resurrect a removed host when its registration response arrives late', async () => {
  const pending = deferred<unknown>()
  const connection = client(() => pending.promise)
  attachPushRegistration('host', connection as never)
  await vi.waitFor(() =>
    expect(connection.sendRequest).toHaveBeenCalledWith(
      'notifications.registerPush',
      expect.anything(),
      expect.anything()
    )
  )
  await unregisterPushForRemovedHost('host')
  pending.resolve({ ok: true, result: { registered: true } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(records().registeredHostIds).toEqual([])
  expect(records().pendingUnregisterHostIds).toEqual([])
})

it('does not start registration after removal while native token lookup was pending', async () => {
  const pending = deferred<MobilePushToken | null>()
  vi.mocked(getDevicePushToken).mockReturnValueOnce(pending.promise)
  const connection = client()
  attachPushRegistration('host', connection as never)
  await vi.waitFor(() => expect(getDevicePushToken).toHaveBeenCalled())
  await unregisterPushForRemovedHost('host')
  pending.resolve(token)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(connection.sendRequest.mock.calls.map(([method]) => method)).not.toContain(
    'notifications.registerPush'
  )
})

it('does not register with stale consent after the user disables notifications during token lookup', async () => {
  const pending = deferred<MobilePushToken | null>()
  vi.mocked(getDevicePushToken).mockReturnValueOnce(pending.promise)
  const connection = client()
  attachPushRegistration('host', connection as never)
  await vi.waitFor(() => expect(getDevicePushToken).toHaveBeenCalled())
  const disabled = setRemotePushEnabled(false)
  pending.resolve(token)
  await disabled
  expect(connection.sendRequest.mock.calls.map(([method]) => method)).not.toContain(
    'notifications.registerPush'
  )
})

it('waits for the Android notification channel before registering a token', async () => {
  const pending = deferred<void>()
  vi.mocked(ensureDesktopNotificationChannel).mockReturnValueOnce(pending.promise)
  const connection = client()
  attachPushRegistration('host', connection as never)
  await vi.waitFor(() => expect(ensureDesktopNotificationChannel).toHaveBeenCalled())
  expect(getDevicePushToken).not.toHaveBeenCalled()
  expect(connection.sendRequest.mock.calls.map(([method]) => method)).not.toContain(
    'notifications.registerPush'
  )
  pending.resolve()
  await vi.waitFor(() =>
    expect(connection.sendRequest.mock.calls.map(([method]) => method)).toContain(
      'notifications.registerPush'
    )
  )
})
