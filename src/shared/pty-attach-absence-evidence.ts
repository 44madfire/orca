/**
 * `pty.attach` refuses with `PTY "<id>" not found` for two unrelated situations: a pid the relay
 * probed and found gone, and an id its session map simply never had — which is every id minted
 * before a relay restart, since ids carry a per-start mint epoch. Only the first observes the
 * process, so only the first carries this marker.
 *
 * The marker is additive on purpose: an answer without it means "ambiguous", which is also what an
 * older relay's unmarked answer means, so a client may never read a missing marker as evidence of
 * anything (docs/reference/ssh-execution-boundary.md).
 */
export const PTY_ATTACH_PROVEN_EXITED_MARKER = 'process exited'

const PROVEN_EXITED_ATTACH_REFUSAL = /PTY ".+" not found \(process exited\)/i

export function isProvenExitedPtyAttachRefusal(error: unknown): boolean {
  return PROVEN_EXITED_ATTACH_REFUSAL.test(error instanceof Error ? error.message : String(error))
}

/**
 * The wording every PTY session owner (daemon host, local provider) mints when the id it was asked
 * to attach is not in its own session map. Unlike the relay marker above this answer is
 * unambiguous: the process that owns the session table answered about itself, so absence is
 * `exited`, never `unverifiable` (docs/reference/ssh-execution-boundary.md).
 *
 * It crosses two process boundaries — daemon socket and Electron IPC — which erase the error class,
 * so the text is the contract. Producers build their message from this constant.
 */
export const SESSION_NOT_FOUND_MESSAGE_PREFIX = 'Session not found: '

export function isSessionNotFoundRefusal(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes(
    SESSION_NOT_FOUND_MESSAGE_PREFIX
  )
}
