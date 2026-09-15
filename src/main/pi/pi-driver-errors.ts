// Pi driver error shaping (SNC1.9 native Pi).
//
// Secret-safe diagnostics shared by the session driver chunks: only stable
// codes, command names, and bounded redacted tails — never prompt text,
// paths, or image bytes.

import { PiRpcError } from './rpc/pi-rpc-errors'

export function sanitizePiError(error: unknown): string {
  if (error instanceof PiRpcError) {
    return error.toSecretSafeString()
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/g, ' ').trim().slice(0, 220) || 'pi-error'
}

export function shortPiError(error: unknown): string {
  if (error instanceof PiRpcError && error.piError) {
    return error.piError
  }
  return sanitizePiError(error)
}

export function classifyStartupError(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  if (code === 'spawn-failed') {
    return 'Pi executable not found or not runnable (spawn-failed). Install Pi on PATH or set an explicit Pi command.'
  }
  if (code === 'startup-failed') {
    return 'Pi exited during startup (startup-failed). Check auth/model/config.'
  }
  if (code === 'startup-timeout') {
    return 'Pi did not become ready in time (startup-timeout). Check model/auth and retry.'
  }
  return `Pi failed to start (${sanitizePiError(error)})`
}
