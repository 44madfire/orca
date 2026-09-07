import { describe, expect, it } from 'vitest'
import { LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS } from '../../../../../main/startup/first-window-startup-services'
import { SPAWN_SETTLEMENT_WATCHDOG_MS } from './pty-connect-limits'

// Why a parity test: the watchdog mirrors main's spawn budgets by value, because a
// renderer module cannot import them. If main's gate grows past this deadline the
// watchdog starts remounting spawns that were about to succeed, which is silent —
// the pane just respawns. Fail here instead.
describe('spawn settlement watchdog budget', () => {
  // Sequential, not overlapping: pty:spawn awaits the startup gate, and only then
  // does the daemon client spend its connection-attempt wait plus one request timeout.
  const DAEMON_CONNECTION_ATTEMPT_WAIT_MS = 5_000 * 4
  const DAEMON_REQUEST_TIMEOUT_MS = 30_000
  const worstLegitimateLocalSettleMs =
    LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS +
    DAEMON_CONNECTION_ATTEMPT_WAIT_MS +
    DAEMON_REQUEST_TIMEOUT_MS

  it('outlasts the slowest settle a local cold start can legitimately take', () => {
    expect(SPAWN_SETTLEMENT_WATCHDOG_MS).toBeGreaterThan(worstLegitimateLocalSettleMs)
  })

  it('keeps real headroom over that worst case rather than racing it', () => {
    expect(SPAWN_SETTLEMENT_WATCHDOG_MS - worstLegitimateLocalSettleMs).toBeGreaterThanOrEqual(
      DAEMON_REQUEST_TIMEOUT_MS
    )
  })
})
