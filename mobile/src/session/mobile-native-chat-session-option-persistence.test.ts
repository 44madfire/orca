import { describe, expect, it, vi } from 'vitest'
import { resolveStructuredLaunchSeedOptions } from '../../../src/shared/native-chat-session-option-defaults'
import type { PersistedNativeChatSessionOptions } from '../../../src/shared/native-chat-session-options'
import type { RpcClient } from '../transport/rpc-client'
import { persistMobileStructuredOptionPicks } from './mobile-native-chat-session-option-persistence'

function hostClient(initial?: PersistedNativeChatSessionOptions) {
  let stored = initial
  const sendRequest = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'settings.get') {
      return {
        id: '1',
        ok: true as const,
        result: { settings: { nativeChatSessionOptions: stored } },
        _meta: { runtimeId: 'host' }
      }
    }
    stored = (params as { nativeChatSessionOptions: PersistedNativeChatSessionOptions })
      .nativeChatSessionOptions
    return { id: '2', ok: true as const, result: null, _meta: { runtimeId: 'host' } }
  })
  return { client: { sendRequest } as unknown as RpcClient, sendRequest, read: () => stored }
}

describe('persistMobileStructuredOptionPicks', () => {
  it('writes the pick to the host record a later launch seeds from', async () => {
    const host = hostClient()
    await persistMobileStructuredOptionPicks({
      client: host.client,
      agent: 'codex',
      picks: [{ modelId: 'gpt-fast', optionId: 'effort', value: 'low' }]
    })
    expect(resolveStructuredLaunchSeedOptions(host.read(), 'codex')).toEqual({
      model: 'gpt-fast',
      effort: 'low'
    })
  })

  it('merges onto the host record instead of replacing another agent', async () => {
    const host = hostClient({
      claude: { model: 'opus', valuesByModel: { opus: { effort: 'high' } } }
    })
    await persistMobileStructuredOptionPicks({
      client: host.client,
      agent: 'codex',
      picks: [{ modelId: 'gpt-fast', optionId: 'model', value: 'gpt-fast' }]
    })
    expect(resolveStructuredLaunchSeedOptions(host.read(), 'claude')).toEqual({
      model: 'opus',
      effort: 'high'
    })
  })

  it('serializes overlapping writes so the later pick keeps the earlier one', async () => {
    const host = hostClient()
    const first = persistMobileStructuredOptionPicks({
      client: host.client,
      agent: 'codex',
      picks: [{ modelId: 'gpt-fast', optionId: 'effort', value: 'low' }]
    })
    const second = persistMobileStructuredOptionPicks({
      client: host.client,
      agent: 'claude',
      picks: [{ modelId: 'opus', optionId: 'effort', value: 'high' }]
    })
    await Promise.all([first, second])
    // A read-modify-write that raced would drop whichever agent read first.
    expect(resolveStructuredLaunchSeedOptions(host.read(), 'codex')).toEqual({
      model: 'gpt-fast',
      effort: 'low'
    })
    expect(resolveStructuredLaunchSeedOptions(host.read(), 'claude')).toEqual({
      model: 'opus',
      effort: 'high'
    })
  })

  it('stays silent without a host or without picks', async () => {
    const host = hostClient()
    await persistMobileStructuredOptionPicks({ client: null, agent: 'codex', picks: [] })
    await persistMobileStructuredOptionPicks({ client: host.client, agent: 'codex', picks: [] })
    expect(host.sendRequest).not.toHaveBeenCalled()
  })
})
