// Why: some agents keep part of a session beside its transcript — Cursor's
// chat meta.json, Cline's messages file. Folding that file's stat into the
// transcript's own mtime/size makes one key mean two things, so a byte offset
// into the transcript can no longer be compared against it and a refused read
// of the sibling takes the transcript down with it. The sidecar is observed
// separately and compared separately.

export type SessionSidecarStat = {
  path: string
  mtimeMs: number
  sizeBytes: number
}

export type SessionSidecarObservation =
  | SessionSidecarStat
  /** This agent declares no sidecar, or it does not exist. */
  | 'none'
  /** It could not be read this scan; nothing may be concluded from its absence. */
  | 'unknown'

/**
 * Whether a cached observation still describes what discovery just saw.
 *
 * Asymmetric on purpose: `file` is observed now, so a missing value means the
 * agent has no sidecar, while `entry` may predate the field (an entry seeded
 * from a cache file an older build wrote), so a missing value means unknown.
 */
export function sidecarUnchanged(
  entry: SessionSidecarObservation | undefined,
  file: SessionSidecarObservation | undefined
): boolean {
  const observed = file ?? 'none'
  if (observed === 'none') {
    return true
  }
  if (observed === 'unknown') {
    return false
  }
  return (
    typeof entry === 'object' &&
    entry.path === observed.path &&
    entry.mtimeMs === observed.mtimeMs &&
    entry.sizeBytes === observed.sizeBytes
  )
}
