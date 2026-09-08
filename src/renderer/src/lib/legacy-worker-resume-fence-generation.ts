// Why a separate module: hydration (inside the store) and the refresh (which writes the store)
// both bump it; keeping it import-free breaks the store → hydration → refresh → store cycle.
let generation = 0

/** A newer hydration or request makes every older in-flight fence reply stale. */
export function advanceLegacyWorkerResumeFenceGeneration(): number {
  return ++generation
}

export function currentLegacyWorkerResumeFenceGeneration(): number {
  return generation
}
