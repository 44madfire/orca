import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-contracts'

export function terminalAttachRefusal(
  result: {
    id: string
    exitedBeforeAttach?: true
    reattachUnverifiable?: true
  },
  owner: { handle: string; tabId: string; paneKey: string; worktreeId: string }
): RuntimeTerminalCreate | null {
  if (!result.exitedBeforeAttach && !result.reattachUnverifiable) {
    return null
  }
  return {
    ...owner,
    ptyId: result.id,
    title: null,
    ...(result.exitedBeforeAttach ? { exitedBeforeAttach: true } : { reattachUnverifiable: true })
  }
}
