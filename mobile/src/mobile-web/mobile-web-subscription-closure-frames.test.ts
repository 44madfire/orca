import { describe, expect, it, vi } from 'vitest'
import type { MobileWebSubscriptionClosure } from './mobile-web-subscription-closure'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebHostSubscriptions } from './mobile-web-host-subscriptions'
import { MobileWebBrowserStreams } from './mobile-web-browser-streams'
import { MobileWebSpeechSubscriptions } from './mobile-web-speech-subscriptions'
import type { MobileWebSpeechEvent } from '../../../src/shared/mobile-web/speech-operation-contract'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const SUBSCRIPTION_ID = 'subscription-1'

type Posts = {
  isActive: () => boolean
  postEvent: (subscriptionId: string, sequence: number, event: unknown) => Promise<void>
  postClosed: (subscriptionId: string, closure: MobileWebSubscriptionClosure) => void
}

type LedgerCase = {
  name: string
  // Browser drops an unparseable frame instead of retiring, so it has no invalid-message closure.
  invalidCode: 'invalid_message' | null
  invalid: unknown
  valid: unknown
  open: (posts: Posts) => Promise<(value: unknown) => void>
}

function randomBytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(4)
}

function hostClient(): { client: RpcClient; emit: (value: unknown) => void } {
  let listener: ((value: unknown) => void) | undefined
  const client = {
    subscribe: vi.fn((_method: string, _params: unknown, onEvent: (value: unknown) => void) => {
      listener = onEvent
      return () => {}
    }),
    sendRequest: vi.fn().mockResolvedValue({
      ok: true,
      result: {
        tabs: [
          {
            type: 'terminal',
            id: 'tab-1',
            terminal: 'terminal-1',
            launchAgent: 'claude',
            agentStatus: { agentType: 'claude', providerSession: { id: 'provider-session-1' } }
          }
        ]
      }
    })
  } as unknown as RpcClient
  return { client, emit: (value) => listener?.(value) }
}

function pageWorkspace(): { authority: MobileWebWorkspaceAuthority; pageWorkspaceId: string } {
  const authority = new MobileWebWorkspaceAuthority(randomBytes)
  authority.synchronize(['workspace-1'])
  return { authority, pageWorkspaceId: authority.pageWorkspaceId('workspace-1') }
}

const LEDGER_CASES: LedgerCase[] = [
  {
    name: 'host',
    invalidCode: null,
    invalid: undefined,
    valid: { type: 'end' },
    open: async (posts) => {
      const host = hostClient()
      const { authority } = pageWorkspace()
      new MobileWebHostSubscriptions({ ...posts, workspaceAuthority: authority }).start({
        requestId: 'request-1',
        subscriptionId: SUBSCRIPTION_ID,
        payload: { method: 'accounts.subscribe', params: {} },
        client: host.client,
        isActive: () => true
      })
      return host.emit
    }
  },
  {
    name: 'browser',
    invalidCode: null,
    invalid: { type: 'bogus' },
    valid: {
      type: 'ready',
      browserPageId: 'raw-page',
      tab: { url: 'https://example.com', title: 'Example', canGoBack: false, canGoForward: false }
    },
    open: async (posts) => {
      const host = hostClient()
      const { authority, pageWorkspaceId } = pageWorkspace()
      new MobileWebBrowserStreams({ ...posts, workspaceAuthority: authority }).start({
        requestId: 'request-1',
        subscriptionId: SUBSCRIPTION_ID,
        payload: {
          workspaceId: pageWorkspaceId,
          pageId: 'raw-page',
          format: 'jpeg',
          quality: 72,
          maxWidth: 800,
          maxHeight: 600,
          everyNthFrame: 1,
          minFrameIntervalMs: 100
        },
        client: host.client
      })
      return host.emit
    }
  },
  {
    name: 'speech',
    // Push-driven from the shell's dictation runtime, so no host frame can be unusable.
    invalidCode: null,
    invalid: { status: 'bogus' },
    valid: { status: 'recording' },
    open: async (posts) => {
      const subscriptions = new MobileWebSpeechSubscriptions(posts)
      subscriptions.start({ requestId: 'request-1', subscriptionId: SUBSCRIPTION_ID })
      return (value) => subscriptions.post(value as MobileWebSpeechEvent)
    }
  }
]

// Ledgers that retire on an unusable host message; browser drops the frame instead, so it is absent.
const RETIRING_LEDGER_CASES = LEDGER_CASES.filter(
  (ledger): ledger is LedgerCase & { invalidCode: 'invalid_message' } => ledger.invalidCode !== null
)

// Without a terminal frame the page keeps a live subscription and freezes on its last value.
describe('shell subscription ledgers publish a closure frame when they retire early', () => {
  it.each(RETIRING_LEDGER_CASES)(
    'closes the $name subscription on an unusable host message',
    async (ledger) => {
      const closures: [string, MobileWebSubscriptionClosure][] = []
      const emit = await ledger.open({
        isActive: () => true,
        postEvent: async () => {},
        postClosed: (subscriptionId, closure) => closures.push([subscriptionId, closure])
      })

      emit(ledger.invalid)

      expect(closures).toEqual([[SUBSCRIPTION_ID, { code: ledger.invalidCode, retryable: false }]])
    }
  )

  it.each(LEDGER_CASES)(
    'closes the $name subscription when the page post fails',
    async (ledger) => {
      const closures: [string, MobileWebSubscriptionClosure][] = []
      const emit = await ledger.open({
        isActive: () => true,
        postEvent: async () => {
          throw new Error('page gone')
        },
        postClosed: (subscriptionId, closure) => closures.push([subscriptionId, closure])
      })

      emit(ledger.valid)
      await vi.waitFor(() => expect(closures).toHaveLength(1))

      expect(closures[0]).toEqual([SUBSCRIPTION_ID, { code: 'unavailable', retryable: true }])
    }
  )
})
