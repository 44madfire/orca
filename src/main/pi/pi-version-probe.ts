// Bounded host-owned `pi --version` probe (SNC1.10 Orca slice).
// Argv only, no shell, bounded output, path-free diagnostics, no secrets.
import { runProcess } from '../../shared/child-process/run-process'
export type PiVersionProbeResult = { ok: true; version: string } | { ok: false; reason: string }
export type PiVersionProbeDeps = {
  command?: string
  timeoutMs?: number
  maxOutputBytes?: number
  runImpl?: typeof runProcess
}
const PI_VERSION_TIMEOUT_MS = 5_000
const PI_VERSION_MAX_BYTES = 8 * 1024
// Runs `pi --version` once, out of band; callers cache the result per install.
export async function probePiVersionBounded(
  deps: PiVersionProbeDeps = {}
): Promise<PiVersionProbeResult> {
  const command = deps.command ?? 'pi'
  const runImpl = deps.runImpl ?? runProcess
  let result: { code: number | null; stdout: string; timedOut: boolean }
  try {
    const observed = await runImpl({
      program: command,
      args: ['--version'],
      timeoutMs: deps.timeoutMs ?? PI_VERSION_TIMEOUT_MS,
      maxOutputBytes: deps.maxOutputBytes ?? PI_VERSION_MAX_BYTES
    })
    result = { code: observed.code, stdout: observed.stdout, timedOut: observed.timedOut }
  } catch {
    return {
      ok: false,
      reason: 'pi-version-unavailable: Pi executable not found or not runnable (use Pi TUI)'
    }
  }
  if (result.timedOut) {
    return { ok: false, reason: 'pi-version-unavailable: Pi version probe timed out (use Pi TUI)' }
  }
  if (result.code !== 0) {
    return { ok: false, reason: 'pi-version-unavailable: Pi version probe failed (use Pi TUI)' }
  }
  const raw = result.stdout.trim()
  if (raw === '') {
    return {
      ok: false,
      reason: 'pi-version-unavailable: Pi version probe returned no output (use Pi TUI)'
    }
  }
  const match = raw.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/)
  if (!match?.[1]) {
    return {
      ok: false,
      reason: 'pi-version-unavailable: Pi version output unparseable (use Pi TUI)'
    }
  }
  return { ok: true, version: match[1] }
}
