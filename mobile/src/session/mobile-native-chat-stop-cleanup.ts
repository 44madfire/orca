import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../src/shared/agent-tui-input-clear'
import type { RpcClient } from '../transport/rpc-client'
import {
  openMobileNativeChatSendBudget,
  sendMobileNativeChatMessageWithOutcome,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import { requestMobileNativeChatStopLease } from './mobile-native-chat-stop-lease'

const CODEX_STOP_BACKGROUND_TERMINALS = '/stop'

type PendingStopCleanup = {
  readonly sessionId: string
  readonly terminal: string
}

const pendingByStream = new Map<string, PendingStopCleanup>()

export async function sendMobileNativeChatStopCleanup(args: {
  client: RpcClient
  deviceToken: string | null
  terminal: string
}): Promise<MobileNativeChatSendOutcome> {
  const deadline = openMobileNativeChatSendBudget()
  const send = (text: string, enter: boolean): Promise<MobileNativeChatSendOutcome> =>
    sendMobileNativeChatMessageWithOutcome({
      client: args.client,
      terminal: args.terminal,
      text,
      enter,
      deadline,
      ...(args.deviceToken
        ? { mobileClient: { id: args.deviceToken, type: 'mobile' as const } }
        : {})
    })
  const cleared = await send(AGENT_TUI_CLEAR_INPUT_MAX, false)
  if (cleared !== 'accepted') {
    // No submit byte was sent, so retrying the idempotent clear is safe even if its ack was lost.
    return 'rejected'
  }
  const body = await send(CODEX_STOP_BACKGROUND_TERMINALS, false)
  // The body-only write cannot run the command; recovery clears any ambiguous partial body.
  return body === 'accepted' ? send('', true) : 'rejected'
}

export function rememberMobileNativeChatStopCleanup(args: {
  streamIdentity: string
  sessionId: string | null
  terminal: string
}): boolean {
  if (!args.sessionId) {
    return false
  }
  pendingByStream.set(args.streamIdentity, {
    sessionId: args.sessionId,
    terminal: args.terminal
  })
  return true
}

export function hasMobileNativeChatStopCleanup(streamIdentity: string): boolean {
  return pendingByStream.has(streamIdentity)
}

export async function recoverMobileNativeChatStopCleanup(args: {
  client: RpcClient
  deviceToken: string | null
  sessionId: string | null
  shouldSend: () => boolean
  streamIdentity: string
  terminal: string
}): Promise<MobileNativeChatSendOutcome | 'busy' | 'none'> {
  const pending = pendingByStream.get(args.streamIdentity)
  if (!pending || pending.sessionId !== args.sessionId || pending.terminal !== args.terminal) {
    return 'none'
  }
  const request = requestMobileNativeChatStopLease(args.terminal, {
    agent: 'codex',
    sessionId: args.sessionId,
    streamIdentity: args.streamIdentity
  })
  if (!request) {
    return 'busy'
  }
  const lease = await request.acquired
  if (!lease) {
    return 'busy'
  }
  try {
    const current = pendingByStream.get(args.streamIdentity)
    if (current !== pending || !args.shouldSend()) {
      return 'none'
    }
    const outcome = await sendMobileNativeChatStopCleanup({
      client: args.client,
      deviceToken: args.deviceToken,
      terminal: args.terminal
    })
    if (outcome !== 'rejected' && pendingByStream.get(args.streamIdentity) === pending) {
      pendingByStream.delete(args.streamIdentity)
    }
    return outcome
  } finally {
    lease.release()
  }
}

export function resetMobileNativeChatStopCleanupForTests(): void {
  pendingByStream.clear()
}
