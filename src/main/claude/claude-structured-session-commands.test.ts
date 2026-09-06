import { describe, expect, it, vi } from 'vitest'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  tick,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

describe('session command updates', () => {
  it('publishes changed catalogs exactly once while idle', async () => {
    const claude = fakeClaude()
    const changed = vi.fn()
    const adapter = adapterFor(
      claude,
      {},
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      changed
    )
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    expect(adapter.readCommands('session-1')?.commands).toBeUndefined()
    const frame = {
      type: 'system',
      subtype: 'commands_changed',
      session_id: PROVIDER_SESSION_ID,
      slash_commands: ['plugin:check', 'doctor'],
      skills: ['plugin:check'],
      terminal_slash_commands: ['doctor']
    }
    claude.connections[0].handlers.onMessage?.(frame)
    await tick()
    expect(adapter.readCommands('session-1')).toEqual({
      commands: [{ name: 'plugin:check', kind: 'skill' }],
      revision: 1
    })
    expect(changed).toHaveBeenCalledExactlyOnceWith('session-1')
    claude.connections[0].handlers.onMessage?.(frame)
    await tick()
    expect(changed).toHaveBeenCalledTimes(1)
    claude.connections[0].handlers.onMessage?.({ ...frame, slash_commands: [] })
    await tick()
    expect(adapter.readCommands('session-1')).toEqual({ commands: [], revision: 2 })
    expect(changed).toHaveBeenCalledTimes(2)
    await adapter.closeSession('session-1')
  })
})
