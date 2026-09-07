/**
 * Pierre tags each rendered row with `data-line`, so a line scroll is a lookup
 * inside the shadow root. Virtualized rows may not exist yet, hence the
 * proportional fallback: land close, then let the caller retry once painted.
 */
export function scrollPierreDiffToLine({
  host,
  container,
  lineNumber,
  side = 'additions',
  hunkIndex,
  hunkCount
}: {
  host: HTMLElement | null
  container: HTMLElement | null
  lineNumber: number
  side?: 'additions' | 'deletions'
  hunkIndex: number
  hunkCount: number
}): boolean {
  if (!container) {
    return false
  }
  const lineType = side === 'additions' ? 'change-addition' : 'change-deletion'
  const root = host?.shadowRoot
  const row =
    root?.querySelector(`[data-code][data-${side}] [data-line="${lineNumber}"]`) ??
    root?.querySelector(`[data-code] [data-line="${lineNumber}"][data-line-type="${lineType}"]`) ??
    root?.querySelector(
      `[data-code]:not([data-deletions]) [data-line="${lineNumber}"]:not([data-line-type="change-deletion"])`
    )
  if (row instanceof HTMLElement) {
    const offset = row.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTop += offset - container.clientHeight / 3
    return true
  }
  if (hunkCount > 0) {
    container.scrollTop = (hunkIndex / hunkCount) * container.scrollHeight
  }
  return false
}
