import { TERMINAL_FENCED_CREATE_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-terminal-contracts'
import type { RpcContext } from './core'

export function negotiateTerminalCreateRefusal<T extends { terminal: RuntimeTerminalCreate }>(
  result: T,
  clientCapabilities: RpcContext['clientCapabilities']
): T {
  if (
    (result.terminal.exitedBeforeAttach || result.terminal.reattachUnverifiable) &&
    !clientCapabilities?.includes(TERMINAL_FENCED_CREATE_RUNTIME_CAPABILITY)
  ) {
    // Older clients interpret every successful create as permission to publish a fresh binding.
    throw Object.assign(new Error('Remote terminal attachment is temporarily unavailable.'), {
      code: 'remote_runtime_unavailable'
    })
  }
  return result
}
