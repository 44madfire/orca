/** Main rewrites the whole set on every recovery pass, so compare by content: an identity check
 *  would republish an unchanged set and wake every session subscriber. */
export function sameFenceSet(current: Record<string, true>, next: Record<string, true>): boolean {
  const nextKeys = Object.keys(next)
  return (
    Object.keys(current).length === nextKeys.length &&
    nextKeys.every((paneKey) => current[paneKey] === true)
  )
}
