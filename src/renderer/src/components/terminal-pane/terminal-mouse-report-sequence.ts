/** True for an xterm mouse report (X10 `CSI M` or SGR `CSI <`): pointer input, never a keystroke. */
export function isXtermMouseReport(data: string): boolean {
  return (
    (data.startsWith('\x1b[M') && data.length === 6) ||
    (data.startsWith('\x1b[<') && /^\d+;\d+;\d+[Mm]$/.test(data.slice(3)))
  )
}
