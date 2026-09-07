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

/** One mobile write's floor claim and provenance verdict, decided together before the bytes move. */
export function newMobileInputWrite(
  input: { terminal: string; client?: TerminalViewportClient; inputKind?: 'query-reply' },
  mobileWithoutClientMetadata: boolean
): MobileInputFloorClaimHolder {
  return {
    handle: input.terminal,
    humanInput: isDeliberateHumanInput(input, mobileWithoutClientMetadata),
    current: null
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
  const clientId = args.isMobile ? args.client?.id : undefined
  // Why: a stream's `isMobile` is read off the same `client` it carries, so the metadata-less
  // legacy phone the unary lane recognises by driver cannot reach this lane at all.
  const floorClaim = newMobileInputWrite(args, false)
  try {
    if (!clientId) {
      const result = await runtime.sendTerminal(args.terminal, action)
      return result.accepted ? 'delivered' : 'rejected'
    }
    const result = await runtime.sendTerminal(args.terminal, action, {
      reserveWrite: (writePtyId) => {
        const claim = runtime.beginMobileInputFloor(writePtyId, clientId)
        if (!claim) {
          throw new Error('mobile_input_floor_unavailable')
        }
        floorClaim.current = claim
      },
      afterWrite: () => settleMobileInputWrite(runtime, floorClaim)
    })
    if (!result.accepted) {
      floorClaim.current?.rollback()
      return 'rejected'
    }
    return 'delivered'
  } catch (error) {
    floorClaim.current?.rollback()
    return isTerminalStreamInputRejection(error) ? 'rejected' : 'failed'
  }
}

export type MobileInputFloorClaimHolder = {
  handle: string
  humanInput: boolean
  current: ReturnType<OrcaRuntimeService['beginMobileInputFloor']>
}

/**
 * Settle an accepted mobile write: the phone keeps the input floor, and if a human produced the
 * bytes the host records that they are now driving this terminal.
 */
export async function settleMobileInputWrite(
  runtime: OrcaRuntimeService,
  claim: MobileInputFloorClaimHolder
): Promise<void> {
  if (claim.humanInput) {
    recordWorkerTerminalUserTakeoverFromInput(runtime, claim.handle)
  }
  await commitMobileInputFloorClaim(claim)
}

async function commitMobileInputFloorClaim(claim: MobileInputFloorClaimHolder): Promise<void> {
  const current = claim.current
  if (!current) {
    return
  }
  try {
    await current.commit()
  } finally {
    // Why: the runtime may yield before the next write, which then needs a fresh reservation if desktop reclaimed the floor.
    if (claim.current === current) {
      claim.current = null
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
