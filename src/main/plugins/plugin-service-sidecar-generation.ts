import { StringDecoder } from 'node:string_decoder'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { serviceExecutionError } from './plugin-service-execution-errors'
import {
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
  wslOverlong: boolean
  framer: { push: (chunk: Buffer) => void; finish: () => void }
}

export type SidecarLifecycleDeps = {
  spawnImpl?: (spec: ProcessSpec) => SpawnedProcess
  ownership?: ProcessOwnershipDeps
  jobBinder?: SidecarJobBinder | null
  sweepGuestImpl?: (distro: string, argv: readonly string[]) => Promise<boolean>
  // In-distro ownership proofs for PID-addressed kills; production runs
  // `cat /proc/<pid>/environ` through wsl.exe bounded.
  guestRunnerImpl?: (distro: string) => GuestCommandRunner
  platform?: NodeJS.Platform
  createNonce?: () => string
}

export type GenerationStreamHooks = {
  isCurrent: (gen: Generation) => boolean
  markReady: (gen: Generation, supervisorPid: number) => void
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
    wslOverlong: false,
    framer: { push: () => undefined, finish: () => undefined }
  }
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
    send: (bytes: Buffer) => void
  }
): Promise<unknown> {
  const encoded = encodeGenerationRequest(requestId, payload, opts.serviceId, opts.maxMessageBytes)
  return new Promise<unknown>((resolve, reject) => {
    // The signal may have fired while the caller awaited startup; an
    // addEventListener on an already-aborted signal never fires.
    if (opts.signal?.aborted) {
      throw serviceExecutionError('cancelled', opts.serviceId)
    }
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
  maxLineBytes: number,
  hooks: GenerationStreamHooks,
  onOverlongLine: () => void
): void {
  if (!isWsl) {
    if (hooks.isCurrent(gen)) {
      gen.framer.push(chunk)
    }
    return
  }
  if (!hooks.isCurrent(gen)) {
    return
  }
  gen.wslText += gen.wslDecoder.write(chunk)
  for (;;) {
    const index = gen.wslText.indexOf('\n')
    if (index === -1) {
      break
    }
    const raw = gen.wslText.slice(0, index)
    gen.wslText = gen.wslText.slice(index + 1)
    if (gen.wslOverlong) {
      // Dropped-tail resync: this remainder is not a message.
      gen.wslOverlong = false
      continue
    }
    // Complete lines are measured too, so a bounded splitter never hands
    // the framer (or the heap) an arbitrarily long line to hold.
    if (Buffer.byteLength(raw, 'utf8') > maxLineBytes) {
      onOverlongLine()
      continue
    }
    pushGenerationLine(gen, raw.endsWith('\r') ? raw.slice(0, -1) : raw, hooks)
  }
  if (gen.wslOverlong) {
    // Still inside the dropped line: keep nothing while waiting for its
    // LF, or an LF-less line would grow the heap across pushes.
    gen.wslText = ''
    return
  }
  // The splitter itself is bounded: an LF-less tail cannot grow the heap
  // waiting for a newline that never comes. Complete lines were already
  // measured one by one inside the bounded framer.
  if (Buffer.byteLength(gen.wslText, 'utf8') > maxLineBytes) {
    gen.wslText = ''
    gen.wslOverlong = true
    onOverlongLine()
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
      gen.guestChildPid = event.pid
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
    const text =
      typeof envelope.error === 'string'
        ? envelope.error
        : (JSON.stringify(envelope.error) ?? 'failed')
    pending.reject(
      new Error(`service ${serviceId} failed: ${text.replace(/[\r\n]+/g, ' ').slice(0, 512)}`)
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
