import type { OrcaPushPayload } from './push-payload'

export type Identity = {
  notificationId: string
  notificationEpoch: string
  notificationSeq: number
}
export function readPushIdentity(value: unknown): Identity | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const item = value as Identity
  return typeof item.notificationId === 'string' &&
    item.notificationId.length > 0 &&
    item.notificationId.length <= 2048 &&
    typeof item.notificationEpoch === 'string' &&
    item.notificationEpoch.length > 0 &&
    item.notificationEpoch.length <= 128 &&
    Number.isSafeInteger(item.notificationSeq) &&
    item.notificationSeq >= 0
    ? {
        notificationId: item.notificationId,
        notificationEpoch: item.notificationEpoch,
        notificationSeq: item.notificationSeq
      }
    : null
}

export function readSummaryMembers(
  value: unknown,
  count: number | undefined
): Identity[] | undefined {
  try {
    const members: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (
      !Number.isSafeInteger(count) ||
      count! < 2 ||
      count! > 32 ||
      !Array.isArray(members) ||
      members.length !== count
    ) {
      return undefined
    }
    const parsed = members.map(readPushIdentity)
    return parsed.every((item): item is Identity => item !== null) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function representedPushes(payload: OrcaPushPayload): OrcaPushPayload[] {
  // Gateway summaries are no longer generated; this bounded reader exists only
  // for notifications already sitting in a user's tray during the transition.
  if ((payload.coalescedCount ?? 0) <= 1) {
    return [payload]
  }
  const members = readSummaryMembers(payload.summaryMembers, payload.coalescedCount)
  return members?.map((member) => ({ hostFingerprint: payload.hostFingerprint, ...member })) ?? []
}
