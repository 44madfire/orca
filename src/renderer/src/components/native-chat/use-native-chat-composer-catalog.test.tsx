// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { structuredSlashCommands } from '../../../../shared/structured-agent-session-composer'

function transport(sessionCommands?: NativeChatStructuredComposerTransport['sessionCommands']) {
  return { sessionCommands } as NativeChatStructuredComposerTransport
}

describe('composer catalog authority', () => {
  it('keeps PTY and unsupported structured providers on their original catalogs', () => {
    const pty = renderHook(() => useNativeChatComposerCatalog('claude'))
    expect(pty.result.current.agentCommands).toEqual(getVerifiedNativeChatCommands('claude'))
    expect(pty.result.current.sessionSkillNames).toBeUndefined()
    const oldHost = renderHook(() => useNativeChatComposerCatalog('claude', transport()))
    expect(oldHost.result.current.agentCommands).toEqual(structuredSlashCommands('claude'))
    expect(oldHost.result.current.sessionSkillNames).toBeUndefined()
  })
  it('respects empty catalogs and command-only catalogs without reviving disk skills', () => {
    const { result, rerender } = renderHook(
      ({ reported }) => useNativeChatComposerCatalog('claude', transport(reported)),
      {
        initialProps: {
          reported: [] as NonNullable<NativeChatStructuredComposerTransport['sessionCommands']>
        }
      }
    )
    expect(result.current).toEqual({ agentCommands: [], sessionSkillNames: [] })
    rerender({ reported: [{ name: 'custom-command', kind: 'command' }] })
    expect(result.current).toEqual({
      agentCommands: [{ name: 'custom-command' }],
      sessionSkillNames: []
    })
  })
})
