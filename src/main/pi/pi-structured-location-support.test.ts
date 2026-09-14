import { describe, expect, it } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { supportsPiStructuredLocation } from './pi-structured-location-support'

const LOCAL_LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'folder'
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('Pi structured location support', () => {
  it('admits only proven local execution, never WSL or remote', () => {
    expect(supportsPiStructuredLocation(LOCAL_LOCATION)).toBe(true)
    expect(supportsPiStructuredLocation({ ...LOCAL_LOCATION, wslDistro: 'Ubuntu' })).toBe(false)
    expect(
      supportsPiStructuredLocation({ ...LOCAL_LOCATION, executionHostId: 'ssh:host-1' })
    ).toBe(false)
    expect(
      supportsPiStructuredLocation({ ...LOCAL_LOCATION, executionHostId: 'runtime:env-1' })
    ).toBe(false)
  })

  it('requires Windows start-time proof so a PID match cannot impersonate a live child', () => {
    withPlatform('win32', () => {
      expect(supportsPiStructuredLocation(LOCAL_LOCATION, () => false)).toBe(false)
      expect(supportsPiStructuredLocation(LOCAL_LOCATION, () => true)).toBe(true)
      expect(
        supportsPiStructuredLocation({ ...LOCAL_LOCATION, wslDistro: 'Ubuntu' }, () => true)
      ).toBe(false)
    })
  })
})
