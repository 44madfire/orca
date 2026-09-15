import { StringDecoder } from 'node:string_decoder'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { serviceExecutionError } from './plugin-service-execution-errors'
import {
  createJsonlFramer,
  decodeSidecarEnvelope,
  encodeSidecarRequest,
  jsonBytes
} from './plugin-service-framed-transport'
import type {
  ClaimedSidecarProcess,
  ProcessOwnershipDeps
} from './plugin-service-process-ownership'
import type { SidecarJobBinder } from './plugin-service-windows-job'
import {
  isSupervisorControlLine,
  parseSupervisorLine,
  type GuestCommandRunner
} from './plugin-service-wsl-supervisor'

// One generation of a sidecar: its process, its in-flight requests, and its
// byte routing. The lifecycle owns when generations live; this module owns
// how bytes move within one. Stale generations are fenced by the caller's
// isCurrent predicate — every entry point checks it before touching state.
export type GenerationState = 'starting' | 'ready' | 'failed' | 'stopping' | 'gone'

export type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type Generation = {
  id: number
  nonce: string
  child: SpawnedProcess | null
  claim: ClaimedSidecarProcess | null
  state: GenerationState
  readyResolve: () => void
  readyReject: (error: Error) => void
  readyPromise: Promise<void>
  exitCode: number | null
  pending: Map<string, PendingRequest>
  guestSupervisorPid: number | null
  guestChildPid: number | null
  wslDecoder: StringDecoder
  wslText: string
  framer: { push: (chunk: Buffer) => void; finish: () => void }
}

export type SidecarLifecycleDeps = {
  spawnImpl?: (spec: ProcessSpec) => SpawnedProcess
  ownership?: ProcessOwnershipDeps
  jobBinder?: SidecarJobBinder | null
  sweepGuestImpl?: (distro: string, script: string) => Promise<boolean>
  // In-distro ownership proofs for PID-addressed kills; production runs
  // `cat /proc/<pid>/environ` through wsl.exe bounded.
  guestRunnerImpl?: (distro: string) => GuestCommandRunner
  platform?: NodeJS.Platform
  createNonce?: () => string
}

export type GenerationStreamHooks = {
  isCurrent: (gen: Generation) => boolean
  markReady: (gen: Generation, supervisorPid: number) => void
  markGuestChild: (gen: Generation, pid: number) => void
}

// Supervisor identity lands here: READY flips a starting generation to
// ready exactly once; late or foreign lines never revive a dead one.
export function markGenerationReady(
  gen: Generation,
  supervisorPid: number,
  isCurrent: boolean
): void {
  gen.guestSupervisorPid = supervisorPid
  if (gen.state === 'starting' && isCurrent) {
    gen.state = 'ready'
    gen.readyResolve()
  }
}

export function markGenerationGuestChild(gen: Generation, pid: number): void {
  gen.guestChildPid = pid
}

export function createGeneration(id: number, nonce: string): Generation {
  let readyResolve!: () => void
  let readyReject!: (error: Error) => void
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  // Avoid an unhandled rejection when the starter stops awaiting readiness.
  readyPromise.catch(() => undefined)
  return {
    id,
    nonce,
    child: null,
    claim: null,
    state: 'starting',
    readyResolve,
    readyReject,
    readyPromise,
    exitCode: null,
    pending: new Map(),
    guestSupervisorPid: null,
    guestChildPid: null,
    wslDecoder: new StringDecoder('utf8'),
    wslText: '',
    framer: { push: () => undefined, finish: () => undefined }
  }
}

export function openGenerationFramer(
  gen: Generation,
  serviceId: string,
  maxLineBytes: number,
  onMessage: (gen: Generation, value: unknown) => void,
  onFramingError: (gen: Generation, error: Error) => void
): void {
  gen.framer = createJsonlFramer(serviceId, maxLineBytes, {
    onMessage: (value) => onMessage(gen, value),
    onFramingError: (error) => onFramingError(gen, error)
  })
}

export function encodeGenerationRequest(
  requestId: string,
  payload: unknown,
  serviceId: string,
  maxMessageBytes: number
): Buffer {
  let encoded: Buffer
  try {
    encoded = encodeSidecarRequest(requestId, payload)
  } catch {
    throw serviceExecutionError('malformed-response', serviceId, 'request is not serializable')
  }
  if (encoded.length > maxMessageBytes) {
    throw serviceExecutionError('malformed-response', serviceId, 'request exceeds bound')
  }
  return encoded
}

// Native bytes flow straight to the framer; WSL stdout is line-split first
// so supervisor control lines never reach JSON parsing.
export type GenerationRequestSend = (bytes: Buffer) => void

// Register one request on a ready generation: timeout, cancellation, and
// settle all clean up after themselves, so a caller-shared AbortSignal never
// accumulates listeners across invokes.
export function sendGenerationRequest(
  gen: Generation,
  requestId: string,
  payload: unknown,
  opts: {
    serviceId: string
    maxMessageBytes: number
    timeoutMs: number
    signal?: AbortSignal
    send: GenerationRequestSend
  }
): Promise<unknown> {
  const encoded = encodeGenerationRequest(requestId, payload, opts.serviceId, opts.maxMessageBytes)
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (gen.pending.delete(requestId)) {
        cleanup()
        reject(serviceExecutionError('timeout', opts.serviceId))
      }
    }, opts.timeoutMs)
    timer.unref?.()
    const cleanup = (): void => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      if (gen.pending.delete(requestId)) {
        cleanup()
        reject(serviceExecutionError('cancelled', opts.serviceId))
      }
    }
    gen.pending.set(requestId, {
      timer,
      resolve: (value) => {
        cleanup()
        resolve(value)
      },
      reject: (error) => {
        cleanup()
        reject(error)
      }
    })
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      opts.send(encoded)
    } catch {
      clearTimeout(timer)
      gen.pending.delete(requestId)
      throw serviceExecutionError('crashed', opts.serviceId, 'sidecar is not running')
    }
  })
}

export function pushGenerationStdout(
  gen: Generation,
  chunk: Buffer,
  isWsl: boolean,
  hooks: GenerationStreamHooks
): void {
  if (!hooks.isCurrent(gen)) {
    return
  }
  if (!isWsl) {
    gen.framer.push(chunk)
    return
  }
  gen.wslText += gen.wslDecoder.write(chunk)
  for (;;) {
    const index = gen.wslText.indexOf('\n')
    if (index === -1) {
      return
    }
    const raw = gen.wslText.slice(0, index)
    gen.wslText = gen.wslText.slice(index + 1)
    pushGenerationLine(gen, raw.endsWith('\r') ? raw.slice(0, -1) : raw, hooks)
  }
}

function pushGenerationLine(gen: Generation, line: string, hooks: GenerationStreamHooks): void {
  if (isSupervisorControlLine(line)) {
    const event = parseSupervisorLine(line, gen.nonce)
    if (!event || !hooks.isCurrent(gen)) {
      return
    }
    if (event.type === 'ready') {
      hooks.markReady(gen, event.pid)
    } else if (event.type === 'child') {
      hooks.markGuestChild(gen, event.pid)
    }
    return
  }
  if (line.length > 0) {
    gen.framer.push(Buffer.from(`${line}\n`, 'utf8'))
  }
}

export function pushGenerationMessage(
  gen: Generation,
  value: unknown,
  serviceId: string,
  maxMessageBytes: number,
  isCurrent: boolean
): void {
  if (!isCurrent) {
    return
  }
  const envelope = decodeSidecarEnvelope(value)
  if (!envelope) {
    failGenerationPending(gen, serviceExecutionError('malformed-response', serviceId), true)
    return
  }
  const pending = gen.pending.get(envelope.id)
  if (!pending) {
    return
  }
  gen.pending.delete(envelope.id)
  clearTimeout(pending.timer)
  if (envelope.error !== undefined) {
    pending.reject(
      new Error(`service ${serviceId} failed: ${boundGenerationErrorText(envelope.error)}`)
    )
    return
  }
  const bytes = jsonBytes(envelope.result ?? null)
  if (bytes === null || bytes > maxMessageBytes) {
    pending.reject(serviceExecutionError('malformed-response', serviceId))
    return
  }
  pending.resolve(envelope.result)
}

export function failGenerationPending(gen: Generation, error: Error, isCurrent: boolean): void {
  if (!isCurrent) {
    return
  }
  for (const pending of gen.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  gen.pending.clear()
}

export function flushGeneration(
  gen: Generation,
  isWsl: boolean,
  hooks: GenerationStreamHooks
): void {
  if (isWsl) {
    gen.wslText += gen.wslDecoder.end()
    const tail = gen.wslText
    gen.wslText = ''
    if (tail.length > 0) {
      pushGenerationLine(gen, tail.endsWith('\r') ? tail.slice(0, -1) : tail, hooks)
    }
  }
  gen.framer.finish()
}

export function boundGenerationErrorText(error: unknown): string {
  const text = typeof error === 'string' ? error : (JSON.stringify(error) ?? 'failed')
  return text.replace(/[\r\n]+/g, ' ').slice(0, 512)
}

// A sidecar whose stderr is never read blocks once the pipe fills; discard it
// (stderr bytes never surface) and swallow stream errors so a dying child
// cannot take the host down through an unhandled `error`.
export function attachQuiet(child: SpawnedProcess, onStdout: (chunk: Buffer) => void): void {
  child.stdout?.on('data', onStdout)
  child.stderr?.on('data', () => undefined)
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on('error', () => undefined)
  }
}

export function detachGenerationStreams(gen: Generation): void {
  for (const stream of [gen.child?.stdin, gen.child?.stdout, gen.child?.stderr]) {
    try {
      stream?.removeAllListeners()
    } catch {
      /* already gone */
    }
  }
}
