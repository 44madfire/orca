import { isAgentSessionPtyWriteRefusedError } from '../../../../../shared/agent-session-pty-write-admission'
import { InvalidArgumentError } from '../../core'
import type {
  DriverState,
  OrcaRuntimeService,
  SubscriptionRegistration
} from '../../../orca-runtime'
import {
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR,
  isTerminalInputTooLargeWithYield
} from '../../../../../shared/terminal-input'
import type { TerminalViewportClient } from './terminal-stream-types'
import { recordWorkerTerminalUserTakeoverFromInput } from '../worker-terminal-user-takeover'

export function isTerminalInputLockedForClient(
  runtime: OrcaRuntimeService,
  ptyId: string,
  client: TerminalViewportClient | undefined
): boolean {
  if (client?.type === 'mobile') {
    return false
  }
  // Why: pre-refactor mobile builds sent no client metadata, so treat a missing client as legacy mobile (unlocked).
  if (!client) {
    return false
  }
  return runtime.getDriver(ptyId).kind === 'mobile'
}

export async function assertTerminalSendTextWithinLimit(text: string | undefined): Promise<void> {
  if (!text) {
    return
  }
  // Why: sends can be paste-sized; validate outside Zod so large input yields before runtime dispatch.
  if (await isTerminalInputTooLargeWithYield(text, TERMINAL_INPUT_MAX_BYTES)) {
    throw new InvalidArgumentError(TERMINAL_INPUT_TOO_LARGE_ERROR)
  }
}

export function resolveMobileFloorClientId(
  driver: DriverState | null,
  client: TerminalViewportClient | undefined
): string | null {
  if (client?.type === 'mobile') {
    return client.id
  }
  if (!client && driver?.kind === 'mobile') {
    return driver.clientId
  }
  return null
}

/**
 * Whether these bytes are a person typing, rather than an agent's `terminal send` or the emulator
 * answering a device query.
 *
 * Deliberately its own rule instead of a read of the mobile input floor. The floor is arbitration,
 * deciding who may write next; this is provenance, deciding who produced the bytes. They agree
 * today, and the orchestration takeover fence hangs off THIS one, so reweighing the floor cannot
 * move the fence without someone answering this question again on its own terms.
 */
export function isDeliberateHumanInput(
  input: { client?: TerminalViewportClient; inputKind?: 'query-reply' },
  mobileWithoutClientMetadata: boolean
): boolean {
  if (input.inputKind === 'query-reply') {
    return false
  }
  if (input.client?.type === 'mobile') {
    return true
  }
  // Pre-refactor mobile builds send no client metadata; the pane's mobile driver, or a mobile
  // stream's own kind, is the only remaining evidence of who is at the keyboard.
  return !input.client && mobileWithoutClientMetadata
}

/**
 * Whether a pane is currently driven from a phone, which is the host's standing reading of input
 * that carries no client metadata — the same policy `isTerminalInputLockedForClient` applies when
 * it lets a clientless write through as a pre-refactor mobile build.
 */
export function isMobileDrivenPane(runtime: OrcaRuntimeService, handle: string): boolean {
  try {
    const ptyId = runtime.resolveLiveLeafForHandle(handle)?.ptyId
    return Boolean(ptyId) && runtime.getDriver(ptyId!).kind === 'mobile'
  } catch {
    // A handle that no longer resolves says nothing about who was typing into it.
    return false
  }
}

/** One accepted write's provenance verdict, decided from the request before the bytes move. */
export function newTerminalInputWrite(
  input: { terminal: string; client?: TerminalViewportClient; inputKind?: 'query-reply' },
  mobileWithoutClientMetadata: boolean
): TerminalInputWrite {
  return {
    handle: input.terminal,
    humanInput: isDeliberateHumanInput(input, mobileWithoutClientMetadata),
    floorClaim: null
  }
}

export type TerminalStreamInputOutcome = 'delivered' | 'rejected' | 'failed'

export function watchSubscriptionLifetime(
  runtime: OrcaRuntimeService,
  ptyId: string,
  signal: AbortSignal | undefined,
  registration: SubscriptionRegistration
): () => void {
  let unsubscribeExit: (() => void) | null = null
  let removeAbort: (() => void) | null = null
  let stopped = false
  const stop = (): void => {
    stopped = true
    unsubscribeExit?.()
    removeAbort?.()
  }
  const release = (): void => {
    registration.releaseIfCurrent()
    stop()
  }
  unsubscribeExit = runtime.subscribeToPtyExit(ptyId, release)
  if (stopped) {
    unsubscribeExit()
    return stop
  }
  if (!signal) {
    return stop
  }
  if (signal.aborted) {
    release()
    return stop
  }
  const onAbort = (): void => release()
  removeAbort = () => signal.removeEventListener('abort', onAbort)
  signal.addEventListener('abort', onAbort, { once: true })
  if (stopped) {
    removeAbort()
  }
  return stop
}

export function isTerminalStreamInputRejection(error: unknown): boolean {
  // Why: a lease refusal is a deliberate rejection, not a transport failure, so the stream reports
  // it through the WriteUnavailable frame old clients already decode rather than a new opcode.
  if (isAgentSessionPtyWriteRefusedError(error)) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('terminal_not_writable') || message.includes('terminal_handle_stale')
}

export async function sendTerminalStreamInput(
  runtime: OrcaRuntimeService,
  args: {
    terminal: string
    text: string
    client: TerminalViewportClient | undefined
    isMobile: boolean
  }
): Promise<TerminalStreamInputOutcome> {
  const action = { text: args.text, enter: false, interrupt: false }
  // Why: a stream's `isMobile` comes from client metadata alone, so a phone that predates
  // `client.type` reports neither; the pane's driver is what the host has left to read it by.
  const inputWrite = newTerminalInputWrite(
    args,
    !args.client && isMobileDrivenPane(runtime, args.terminal)
  )
  // Only a client that named itself can hold the floor, but every accepted write settles.
  const clientId = args.isMobile ? args.client?.id : undefined
  try {
    const result = await runtime.sendTerminal(args.terminal, action, {
      ...(clientId
        ? {
            reserveWrite: (writePtyId: string): void => {
              const claim = runtime.beginMobileInputFloor(writePtyId, clientId)
              if (!claim) {
                throw new Error('mobile_input_floor_unavailable')
              }
              inputWrite.floorClaim = claim
            }
          }
        : {}),
      afterWrite: () => settleTerminalInputWrite(runtime, inputWrite)
    })
    if (!result.accepted) {
      inputWrite.floorClaim?.rollback()
      return 'rejected'
    }
    return 'delivered'
  } catch (error) {
    inputWrite.floorClaim?.rollback()
    return isTerminalStreamInputRejection(error) ? 'rejected' : 'failed'
  }
}

/**
 * One write in flight: who produced the bytes, and the input floor it reserved if it reserved one.
 * Provenance stands on its own here — a write with no floor claim still records a takeover.
 */
export type TerminalInputWrite = {
  handle: string
  humanInput: boolean
  floorClaim: ReturnType<OrcaRuntimeService['beginMobileInputFloor']>
}

/**
 * Settle an accepted write: if a human produced the bytes the host records that they are now
 * driving this terminal, and a phone that reserved the input floor keeps it.
 *
 * Runs on every accepted write, not only floor-reserving ones, so provenance alone decides the
 * takeover. A write holding no claim commits nothing.
 */
export async function settleTerminalInputWrite(
  runtime: OrcaRuntimeService,
  write: TerminalInputWrite
): Promise<void> {
  if (write.humanInput) {
    recordWorkerTerminalUserTakeoverFromInput(runtime, write.handle)
  }
  const claim = write.floorClaim
  if (!claim) {
    return
  }
  try {
    await claim.commit()
  } finally {
    // Why: the runtime may yield before the next write, which then needs a fresh reservation if desktop reclaimed the floor.
    if (write.floorClaim === claim) {
      write.floorClaim = null
    }
  }
}

export function getTerminalSendGuardRefusedReason(
  error: unknown
): 'no-agent' | 'permission' | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('terminal_guard_permission')) {
    return 'permission'
  }
  if (message.includes('terminal_guard_no_agent')) {
    return 'no-agent'
  }
  return undefined
}

export function isTerminalSendGuardNotWritable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('terminal_guard_not_writable')
}

export function assertTerminalSendExactPtyBinding(
  runtime: OrcaRuntimeService,
  handle: string,
  expectedPtyId: string | undefined
): void {
  try {
    if (expectedPtyId && runtime.resolveLiveLeafForHandle(handle)?.ptyId === expectedPtyId) {
      return
    }
  } catch {
    // Fall through to the stable guarded-send result below.
  }
  throw new Error('terminal_guard_not_writable')
}
