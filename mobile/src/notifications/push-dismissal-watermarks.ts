import AsyncStorage from '@react-native-async-storage/async-storage'
import type { OrcaPushPayload } from './push-payload'

const STORAGE_KEY = 'orca:pushDismissalWatermarks:v1'
const RETENTION_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 512

type Entry = { key: string; seq: number; expiresAt: number }
let writes: Promise<void> = Promise.resolve()

function eventKey(payload: OrcaPushPayload): string | null {
  if (
    !payload.notificationId ||
    !payload.notificationEpoch ||
    !Number.isSafeInteger(payload.notificationSeq) ||
    payload.notificationSeq! < 0
  ) {
    return null
  }
  return JSON.stringify([
    payload.hostFingerprint,
    payload.notificationEpoch,
    payload.notificationId
  ])
}

async function readEntries(): Promise<Entry[]> {
  try {
    const raw: unknown = JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) ?? '[]')
    if (!Array.isArray(raw)) {
      return []
    }
    return raw.filter(
      (entry): entry is Entry =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.key === 'string' &&
        Number.isSafeInteger(entry.seq) &&
        entry.seq >= 0 &&
        Number.isFinite(entry.expiresAt) &&
        entry.expiresAt > Date.now()
    )
  } catch {
    return []
  }
}

export function rememberPushDismissal(payload: OrcaPushPayload): Promise<void> {
  const key = eventKey(payload)
  if (!key) {
    return Promise.resolve()
  }
  const pending = writes.then(async () => {
    const entries = await readEntries()
    const previous = entries.find((entry) => entry.key === key)
    const entry = {
      key,
      seq: Math.max(previous?.seq ?? 0, payload.notificationSeq!),
      expiresAt: Date.now() + RETENTION_MS
    }
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([...entries.filter((item) => item.key !== key), entry].slice(-MAX_ENTRIES))
    )
  })
  writes = pending.catch(() => {})
  return writes
}

export async function wasPushDismissed(payload: OrcaPushPayload): Promise<boolean> {
  // A summary may also represent alerts the dismissal does not cover.
  if ((payload.coalescedCount ?? 0) > 1) {
    return false
  }
  const key = eventKey(payload)
  if (!key) {
    return false
  }
  await writes
  return (await readEntries()).some(
    (entry) => entry.key === key && entry.seq >= payload.notificationSeq!
  )
}
