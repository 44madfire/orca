const listeners = new Set<() => void>()
export function notifyNotificationConsentChanged(): void {
  for (const listener of listeners) {
    listener()
  }
}
export function subscribeNotificationConsent(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
