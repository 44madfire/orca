import { beforeEach, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import { shouldSuppressForegroundPush } from './push-receive'
import {
  getHostNotificationSession,
  resetHostNotificationSessionsForTests
} from './notification-reconnect-catchup'
import type { RpcClient } from '../transport/rpc-client'

vi.mock('react-native', () => ({ AppState: { currentState: 'active' }, Platform: { OS: 'ios' } }))
vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: vi.fn(async () => []),
  getPermissionsAsync: vi.fn(async () => ({ status: 'granted', canAskAgain: true })),
  scheduleNotificationAsync: vi.fn(async () => 'local'),
  dismissNotificationAsync: vi.fn(async () => {})
}))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn(async () => [{ id: 'host' }]) }))
vi.mock('./push-host-fingerprint', () => ({
  resolveHostIdForFingerprint: () => 'host',
  deriveHostFingerprint: () => 'abcdefghijklmnop'
}))
vi.mock('../storage/preferences', () => ({
  loadRemotePushEnabled: async () => true,
  loadPushNotificationsEnabled: async () => true,
  loadRemotePushHostRegistrations: async () => ({ registeredHostIds: ['host'] })
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))
const event = {
  type: 'notification',
  source: 'agent-task-complete',
  title: 'Done',
  body: '',
  notificationId: 'done',
  notificationSeq: 1,
  notificationEpoch: 'epoch'
}
const push = { orca: { ...event, hostFingerprint: 'abcdefghijklmnop' } }
const disposals: (() => void)[] = []
beforeEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose()
  }
  vi.clearAllMocks()
  resetHostNotificationSessionsForTests()
})
async function socket() {
  let receive!: (data: unknown) => void
  const client = {
    subscribe: (_method: string, _params: unknown, callback: typeof receive) => {
      receive = callback
      return () => {}
    },
    getState: () => 'connected',
    sendRequest: async () => ({ ok: true, result: { notifications: [] } })
  }
  disposals.push(subscribeToDesktopNotifications(client as unknown as RpcClient, 'host'))
  receive({ type: 'ready', subscriptionId: 'sub', epoch: 'epoch' })
  await getHostNotificationSession('host').watermarkSeeded
  return receive
}

it('does not show a second banner when a foreground push precedes its live socket event', async () => {
  const receive = await socket()
  expect(await shouldSuppressForegroundPush(push)).toBe(false)
  receive(event)
  await vi.waitFor(() => expect(getHostNotificationSession('host').lastDeliveredSeq).toBe(1))
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled()
})

it('waits for in-flight socket scheduling before deciding whether to show its push', async () => {
  let finish!: (id: string) => void
  vi.mocked(Notifications.scheduleNotificationAsync).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const receive = await socket()
  receive(event)
  await vi.waitFor(() => expect(finish).toBeDefined())
  let decision: boolean | undefined
  const pending = shouldSuppressForegroundPush(push).then((value) => {
    decision = value
    return value
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const beforeScheduleFinished = decision
  finish('local')
  expect(await pending).toBe(true)
  expect(beforeScheduleFinished).toBeUndefined()
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledOnce()
})

it('lets the push deliver if the in-flight local schedule fails', async () => {
  let fail!: (error: Error) => void
  vi.mocked(Notifications.scheduleNotificationAsync).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
  )
  const receive = await socket()
  receive(event)
  await vi.waitFor(() => expect(fail).toBeDefined())
  const pending = shouldSuppressForegroundPush(push)
  fail(new Error('native scheduling failed'))
  expect(await pending).toBe(false)
})

it('dismisses the tray while an earlier socket show is still waiting for foreground', async () => {
  const { AppState } = await import('react-native')
  let activate!: (state: string) => void
  Object.assign(AppState, {
    currentState: 'background',
    addEventListener: (_name: string, callback: typeof activate) => {
      activate = callback
      return { remove: () => {} }
    }
  })
  const receive = await socket()
  receive(event)
  await vi.waitFor(() => expect(activate).toBeDefined())
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValueOnce([
    { request: { identifier: 'remote-alert', content: { data: push } } }
  ] as never)
  receive({ ...event, type: 'dismiss', notificationSeq: 2 })
  await vi.waitFor(() =>
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('remote-alert')
  )
  AppState.currentState = 'active'
  activate('active')
})
