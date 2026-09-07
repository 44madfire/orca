import { useCallback } from 'react'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'

/** Codex's own command for reaping the background terminals a turn spawned.
 *  Escape interrupts the turn; it never touches them. */
const CODEX_STOP_BACKGROUND_TERMINALS = '/stop'

/** Stop's background-terminal cleanup, routed through the send seam's command
 *  dispatcher so it types the command key by key and takes the per-terminal
 *  write lock rather than opening a second, unserialized write path. */
export function useCodexBackgroundTerminalStop(
  dispatchCommand: (text: string) => Promise<MobileNativeChatSendOutcome>
): () => Promise<MobileNativeChatSendOutcome> {
  return useCallback(() => dispatchCommand(CODEX_STOP_BACKGROUND_TERMINALS), [dispatchCommand])
}
