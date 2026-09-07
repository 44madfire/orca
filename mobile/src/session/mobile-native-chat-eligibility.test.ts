import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import { canShowMobileNativeChat, resolveMobileNativeChat } from './mobile-native-chat-eligibility'

function status(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    paneKey: 'tab:leaf',
    ...overrides
  } as AgentStatusEntry
}

describe('resolveMobileNativeChat', () => {
  it('prefers the authoritative supported live agent over a stale launch hint', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        launchAgent: 'claude',
        agentStatus: {
          agentType: 'codex',
          providerSession: { id: 'codex-session', transcriptPath: '/tmp/codex.jsonl' }
        }
      } as never)
    ).toMatchObject({ agent: 'codex', sessionId: 'codex-session' })
  })

  it('rejects an unsupported live agent instead of combining it with a stale hint', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        launchAgent: 'claude',
        agentStatus: {
          agentType: 'gemini',
          providerSession: { id: 'gemini-session', transcriptPath: '/tmp/gemini.jsonl' }
        }
      } as never)
    ).toBeNull()
  })
  it('resolves agent + sessionId from launchAgent and provider session', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        launchAgent: 'claude',
        agentStatus: status({
          providerSession: {
            key: 'session_id',
            id: 'sess-1',
            transcriptPath: '/tmp/claude-real-transcript.jsonl'
          }
        })
      })
    ).toEqual({
      agent: 'claude',
      sessionId: 'sess-1',
      transcriptPath: '/tmp/claude-real-transcript.jsonl'
    })
  })

  it('falls back to agentStatus.agentType when no launchAgent', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        agentStatus: status({ agentType: 'codex' })
      })
    ).toEqual({ agent: 'codex', sessionId: null, transcriptPath: null })
  })

  it('uses the opaque hosted session identity instead of provider metadata', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        launchAgent: 'claude',
        nativeChatSessionId: `native_chat_0_${'01'.repeat(16)}`,
        agentStatus: {
          state: 'waiting',
          agentType: 'claude'
        }
      })
    ).toEqual({
      agent: 'claude',
      sessionId: `native_chat_0_${'01'.repeat(16)}`,
      transcriptPath: null
    })
  })

  it('admits OpenClaude with its distinct agent identity', () => {
    expect(resolveMobileNativeChat({ type: 'terminal', launchAgent: 'openclaude' })).toEqual({
      agent: 'openclaude',
      sessionId: null,
      transcriptPath: null
    })
  })

  it('returns null for unsupported agents', () => {
    expect(resolveMobileNativeChat({ type: 'terminal', launchAgent: 'gemini' })).toBeNull()
  })

  it.each(['grok', 'omp'])('admits %s on the transcript agents the host reads', (launchAgent) => {
    const tab = { type: 'terminal', launchAgent }
    expect(resolveMobileNativeChat(tab)).toMatchObject({ agent: launchAgent })
    expect(canShowMobileNativeChat(tab)).toBe(true)
  })

  it('returns null for a plain shell (no agent)', () => {
    expect(resolveMobileNativeChat({ type: 'terminal' })).toBeNull()
  })

  it('returns null for non-terminal tabs', () => {
    expect(resolveMobileNativeChat({ type: 'browser', launchAgent: 'claude' })).toBeNull()
  })

  it('resolves Codex structured agent-session tabs directly', () => {
    expect(
      resolveMobileNativeChat({
        type: 'agent-session',
        sessionId: 'structured-1',
        agent: 'codex'
      })
    ).toEqual({
      agent: 'codex',
      sessionId: 'structured-1',
      transcriptPath: null
    })
  })

  it('resolves Claude structured agent-session tabs on the same journal path', () => {
    expect(
      resolveMobileNativeChat({
        type: 'agent-session',
        sessionId: 'structured-1',
        agent: 'claude'
      })
    ).toEqual({
      agent: 'claude',
      sessionId: 'structured-1',
      transcriptPath: null
    })
  })

  it('rejects structured agent-session tabs whose provider the reducer cannot replay', () => {
    expect(
      resolveMobileNativeChat({
        type: 'agent-session',
        sessionId: 'structured-1',
        agent: 'grok'
      })
    ).toBeNull()
  })

  it('canShowMobileNativeChat mirrors resolution', () => {
    expect(canShowMobileNativeChat({ type: 'terminal', launchAgent: 'claude' })).toBe(true)
    expect(canShowMobileNativeChat(null)).toBe(false)
  })
})
