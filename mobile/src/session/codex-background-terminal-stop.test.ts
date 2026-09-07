import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

// The Stop hook receives the cleanup as a callback, so only a controller-level
// render proves that callback actually reaches the send seam's command
// dispatcher — and with it the per-terminal write lock.
type StopHookArgs = {
  agentRef: { current: string | null }
  stopBackgroundTerminals: () => Promise<string>
}
const stopArgs: StopHookArgs[] = []

vi.mock('./use-mobile-native-chat-stop', () => ({
  useMobileNativeChatStop: (args: StopHookArgs) => {
    stopArgs.push(args)
    return vi.fn()
  }
}))
vi.mock('./use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({ isTabChatView: () => true, toggleTabChatView: vi.fn() })
}))
vi.mock('./use-mobile-native-chat-session', () => ({
  useMobileNativeChatSession: () => ({ messages: [], status: 'ready', transcriptLoading: false })
}))
vi.mock('./use-mobile-structured-agent-session', () => ({
  useMobileStructuredAgentSession: () => ({
    session: { messages: [], status: 'ready', transcriptLoading: false, hasMore: false },
    isWorking: false,
    turnId: null,
    sendWithOutcome: vi.fn(),
    cancel: vi.fn(),
    permission: null,
    question: null,
    optionSnapshot: [],
    optionSurface: { getSnapshot: () => [], subscribe: () => () => {} },
    pendingOptionId: null,
    respondPermission: vi.fn(),
    respondQuestion: vi.fn(),
    setStructuredOption: vi.fn(),
    invokeStructuredOption: vi.fn()
  })
}))
vi.mock('./use-mobile-native-chat-drafts', () => ({
  useMobileNativeChatDrafts: () => ({
    composerText: '',
    setComposerText: vi.fn(),
    pending: [],
    imagePreviewsByMessageId: {},
    captureSendOrigin: vi.fn(),
    readSeededLaunchDraft: () => null,
    readSeededLaunchDraftSeed: () => null,
    clearDraftForSend: vi.fn(),
    restoreRejectedDraft: vi.fn(),
    acceptSend: vi.fn(),
    holdUnconfirmedSend: vi.fn()
  })
}))
vi.mock('./use-mobile-native-chat-prompts', () => ({
  useMobileNativeChatPrompts: () => ({
    permission: null,
    question: null,
    detectedAsk: null,
    ask: null
  })
}))
vi.mock('./use-mobile-native-chat-answer-send', () => ({
  useMobileNativeChatAnswerSend: () => ({ answerAsk: vi.fn(), cancelPending: vi.fn() })
}))
vi.mock('./mobile-native-chat-permission-send', () => ({
  useMobileNativeChatPermissionSend: () => vi.fn()
}))
vi.mock('./use-mobile-native-chat-file-search', () => ({
  useMobileNativeChatFileSearch: () => ({ nativeChatFilePaths: [], loadNativeChatFiles: vi.fn() })
}))

import {
  acquireMobileNativeChatTerminalWrite,
  resetMobileNativeChatTerminalWritesForTests
} from './mobile-native-chat-terminal-write-lock'
import { resetMobileNativeChatStaleInputForTests } from './mobile-native-chat-stale-input'
import { useMobileNativeChatController } from './use-mobile-native-chat-controller'

const ACCEPTED = {
  id: 'send',
  ok: true,
  result: { send: { accepted: true } },
  _meta: { runtimeId: 'r' }
}

describe('codex background-terminal cleanup wiring', () => {
  let renderer: ReactTestRenderer | null = null
  const clientStub = { sendRequest: vi.fn() }

  const codexTab = {
    type: 'terminal',
    id: 'tab-1',
    terminal: 'term-1',
    launchAgent: 'codex',
    agentStatus: { state: 'working', agentType: 'codex', providerSession: { id: 'session-1' } },
    isActive: true
  }

  function Harness(): null {
    useMobileNativeChatController({
      client: clientStub as unknown as RpcClient,
      connState: 'connected',
      hostId: 'h',
      worktreeId: 'w',
      activeSessionTab: codexTab as never,
      activeSessionTabId: 'tab-1',
      activeHandleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      nativeChatTranscriptIsLocalReadable: true,
      nativeChatInputLeaseReady: true,
      onSendError: vi.fn(),
      onSendResolved: vi.fn()
    })
    return null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    stopArgs.length = 0
    resetMobileNativeChatStaleInputForTests()
    resetMobileNativeChatTerminalWritesForTests()
    clientStub.sendRequest.mockResolvedValue(ACCEPTED)
    act(() => {
      renderer = create(createElement(Harness))
    })
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('resolves the active agent as codex for the Stop hook', () => {
    expect(stopArgs.at(-1)?.agentRef.current).toBe('codex')
  })

  it('types /stop one key at a time so the TUI reads it as a command, not prose', async () => {
    await act(async () => {
      await stopArgs.at(-1)?.stopBackgroundTerminals()
    })

    const typed = clientStub.sendRequest.mock.calls
      .filter(([method]) => method === 'terminal.send')
      .map(([, params]) => (params as { text: string }).text)
    // Ctrl+U first, so /stop cannot submit a draft the user left in the
    // composer; the trailing CR is the submit.
    expect(typed).toEqual(['\x15', '/', 's', 't', 'o', 'p', '\r'])
  })

  it('holds the per-terminal write lock so a concurrent paste cannot interleave', async () => {
    let claimedDuringCleanup: boolean | null = null
    clientStub.sendRequest.mockImplementation(() => {
      claimedDuringCleanup ??= acquireMobileNativeChatTerminalWrite('term-1')
      return Promise.resolve(ACCEPTED)
    })

    await act(async () => {
      await stopArgs.at(-1)?.stopBackgroundTerminals()
    })

    expect(claimedDuringCleanup).toBe(false)
    // Released afterwards, so the next real send is not locked out.
    expect(acquireMobileNativeChatTerminalWrite('term-1')).toBe(true)
  })
})
