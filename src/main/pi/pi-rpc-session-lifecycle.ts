// Pi RPC session lifecycle: acquire, close, and session-file tracking (SNC1.9).
//
// Mechanical split of `pi-rpc-session-driver.ts` (protected-subclass chain,
// one class per file) so each file meets the line budget. Turn dispatch and
// streaming/options live in `pi-rpc-session-turns` and `pi-rpc-session-driver`.

// First-party Pi RPC session driver (SNC1.9 native Pi).
//
// Owns one `pi --mode rpc` child per Orca structured session over the vendored
// transport (`./rpc`), with Pi semantics following the proven orca-pi
// `PiBridgeProvider` flows as reference: exact-cwd spawn, `get_state` lease
// identity, typed `switch_session` resume with header CWD validation,
// single-turn dispatch honesty, translator-driven streaming, exactly-once
// prompts with retirement, exact-match options, wholesale history rebuild,
// and close that proves root exit plus descendant cleanup.
//
// Orca owns fencing, process identity, and the journal: the driver never
// mints leases, never probes start times, and never writes user rows (the
// host owns the outbox). Journal rows come only from streamed Pi events under
// stable turn-scoped keys, so finals reconcile rather than duplicate. All
// failures are actionable `PI_*` errors without paths, prompt text, or bytes.

import { isAbsolute } from 'node:path'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { PiRpcConnection } from './rpc/pi-rpc-connection'
import { PiRpcError } from './rpc/pi-rpc-errors'
import { resolvePiRpcEnv, toPiRpcProcessSpec } from './rpc/pi-rpc-launch'
import type { PiState } from './rpc/pi-wire-protocol'
import { spawnProcess } from '../../shared/child-process/run-process'
import type { SpawnedProcess } from '../../shared/child-process/process-spec'
import { PiTranslator } from './translation/pi-turn-translator'
import { qualifyPiModelRef } from './pi-session-options'
import { rebuildPiHistory, resumePiSession } from './pi-rpc-session-resume'
import { createPiTurnBuffer } from './pi-event-journal'
import { PiSessionOptionState } from './pi-session-options'
import {
  isPiPidAbsent,
  PiRootExitObservedError,
  terminatePiProcessTree
} from './pi-process-teardown'
import { PI_SPAWN_TOKEN_ENV } from './pi-structured-owner-identity'
import { classifyStartupError, shortPiError } from './pi-driver-errors'
import type { PiAcquireCompat } from './pi-structured-compat'
import { assertDriverAcquireCompat, verifyDriverLiveCompat } from './pi-driver-compat'

function argsForOptions(
  options: Readonly<Record<string, string>> | undefined,
  baseArgs: readonly string[]
): string[] {
  const extra: string[] = []
  if (options?.['model'] && !baseArgs.includes('--model')) {
    extra.push('--model', options['model'])
  }
  if (options?.['thinkingLevel'] && !baseArgs.includes('--thinking')) {
    extra.push('--thinking', options['thinkingLevel'])
  }
  return extra
}

export type PiDriverAcquireInput = {
  orcaSessionId: string
  workspaceRoot: string
  resumeSessionFile?: string
  resumePiSessionId?: string | null
  options?: Readonly<Record<string, string>>
  spawnToken: string
  sink?: StructuredAgentSessionEventSink | null
  compat?: PiAcquireCompat
}

export type PiDriverAcquireResult = {
  piSessionId: string
  leafId: string | null
  resumed: boolean
  sessionFile: string | null
  model: string | undefined
  thinkingLevel: string | undefined
  pid: number | undefined
}

export type PiDriverDispatchResult =
  | { status: 'accepted' }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; reason: string }

export type PiDriverDeps = {
  piCommand?: string
  piArgs?: readonly string[]
  piEnv?: NodeJS.ProcessEnv
  resolveEnv?: () => Promise<NodeJS.ProcessEnv> | NodeJS.ProcessEnv
  spawnImpl?: typeof spawnProcess
  defaultTimeoutMs?: number
  startupTimeoutMs?: number
  optionTimeoutMs?: number
  closeGraceMs?: number
  liveProbeTimeoutMs?: number
  requireCompat?: boolean
  onUnexpectedExit?: (orcaSessionId: string) => void
}

const PI_OPTION_TIMEOUT_MS = 8_000
const PI_CLOSE_GRACE_MS = 2_000
const PI_CATALOG_LOOKUP_TIMEOUT_MS = 3_000

export abstract class PiRpcSessionLifecycle {
  protected conn: PiRpcConnection | null = null
  protected child: SpawnedProcess | null = null
  protected readonly translator = new PiTranslator()
  protected readonly optionsState = new PiSessionOptionState()
  protected queueMode: string | undefined
  protected autoCompaction: boolean | undefined
  protected leafId: string | null = null
  protected sessionFile: string | null = null
  protected activeOp: string | null = null
  protected sink: StructuredAgentSessionEventSink | null = null
  protected pendingImmediate: { opId: string; acked: boolean; accept: () => void } | null = null
  protected closing = false
  protected closed = false
  protected opSeq = 0
  protected turn = createPiTurnBuffer()
  /** Journal item key → owning session + Pi dialog id; answers route through here. */
  readonly promptTracker = new Map<string, { sessionId: string; requestId: string }>()

  constructor(
    protected readonly orcaSessionId: string,
    protected readonly deps: PiDriverDeps = {}
  ) {}

  protected get optionTimeout(): number {
    return this.deps.optionTimeoutMs ?? PI_OPTION_TIMEOUT_MS
  }

  protected get closeGrace(): number {
    return this.deps.closeGraceMs ?? PI_CLOSE_GRACE_MS
  }
  async acquire(
    input: Omit<PiDriverAcquireInput, 'orcaSessionId'>
  ): Promise<PiDriverAcquireResult> {
    if (!input.workspaceRoot || input.workspaceRoot.trim() === '') {
      throw new Error('BAD_WORKSPACE: acquire requires a non-empty workspaceRoot')
    }
    if (!isAbsolute(input.workspaceRoot)) {
      throw new Error('BAD_WORKSPACE: acquire requires an absolute workspaceRoot')
    }
    assertDriverAcquireCompat(input, this.deps)
    this.sink = input.sink ?? null
    const baseEnv = (await this.deps.resolveEnv?.()) ?? process.env
    let command = this.deps.piCommand ?? 'pi'
    let args: readonly string[] = [
      ...(this.deps.piArgs ?? []),
      ...argsForOptions(input.options, this.deps.piArgs ?? [])
    ]
    try {
      const spec = toPiRpcProcessSpec({ command, cwd: input.workspaceRoot, args })
      command = spec.command
      args = [...spec.args]
    } catch {
      throw new Error('PI_TUI_FLAG: Pi launch rejects TUI-only flags')
    }
    const spawnImpl = this.deps.spawnImpl ?? spawnProcess
    const conn = new PiRpcConnection({
      piCommand: command,
      piArgs: args,
      cwd: input.workspaceRoot,
      env: resolvePiRpcEnv({ ...this.deps.piEnv, [PI_SPAWN_TOKEN_ENV]: input.spawnToken }, baseEnv),
      spawnFn: (program, argv, options) => {
        const child = spawnImpl({
          program,
          args: argv,
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options.env !== undefined ? { env: options.env } : {}),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32'
        }) as SpawnedProcess
        this.child = child
        return child
      },
      ...(this.deps.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: this.deps.defaultTimeoutMs }
        : {}),
      ...(this.deps.startupTimeoutMs !== undefined
        ? { startupTimeoutMs: this.deps.startupTimeoutMs }
        : {})
    })
    this.conn = conn
    try {
      await conn.start()
    } catch (error) {
      await conn.close(0).catch(() => undefined)
      // A spawn error means the OS never created a provider process. Drop the
      // transport ownership so a missing/unrunnable binary remains retryable;
      // startup failures after spawn stay fenced through backend cleanup.
      if (error instanceof PiRpcError && error.code === 'spawn-failed') {
        this.conn = null
        this.child = null
      }
      throw new Error(`PI_STARTUP_FAILED: ${classifyStartupError(error)}`)
    }
    try {
      return await this.finishAcquire(conn, input)
    } catch (error) {
      await conn.close(this.closeGrace).catch(() => undefined)
      throw error
    }
  }

  // Implemented by the driver subclass: option application and event
  // streaming touch live RPC and journal state owned downstream.
  protected abstract applyOptions(
    options: Readonly<Record<string, string>>
  ): Promise<Record<string, string>>
  protected abstract handlePiRecord(record: Record<string, unknown>): void

  protected async finishAcquire(
    conn: PiRpcConnection,
    input: Omit<PiDriverAcquireInput, 'orcaSessionId'>
  ): Promise<PiDriverAcquireResult> {
    let state: PiState
    try {
      state = await conn.getState()
    } catch (error) {
      throw new Error(`PI_STATE_FAILED: Pi started but get_state failed (${shortPiError(error)})`)
    }
    // Live capability verification against the running Pi, before exposure.
    // Refusal closes the just-started child via the acquire() wrapper.
    await verifyDriverLiveCompat(conn, input, this.deps)
    let resumed = false
    if (input.resumeSessionFile !== undefined) {
      const outcome = await resumePiSession(conn, {
        resumePath: input.resumeSessionFile,
        workspaceRoot: input.workspaceRoot,
        timeoutMs: this.optionTimeout
      })
      state = outcome.state
      resumed = outcome.resumed
    }
    const piSessionId =
      typeof state.sessionId === 'string' && state.sessionId !== '' ? state.sessionId : null
    if (!piSessionId) {
      throw new Error('PI_STATE_FAILED: Pi started but reported no session id')
    }
    if (input.resumePiSessionId && piSessionId !== input.resumePiSessionId) {
      throw new Error('PI_RESUME_FAILED: Pi resumed a different session than requested')
    }
    this.sessionFile =
      typeof state.sessionFile === 'string' && state.sessionFile !== '' ? state.sessionFile : null
    this.optionsState.model = qualifyPiModelRef(state.model) ?? input.options?.['model']
    if (typeof state.thinkingLevel === 'string') {
      this.optionsState.thinkingLevel = state.thinkingLevel
    } else if (input.options?.['thinkingLevel']) {
      this.optionsState.thinkingLevel = input.options['thinkingLevel']
    }
    if (input.options && Object.keys(input.options).length > 0) {
      await this.applyOptions(input.options)
    }
    if (resumed) {
      const rebuilt = await rebuildPiHistory(conn, {
        timeoutMs: this.optionTimeout,
        busy: false,
        closed: false
      })
      if (!rebuilt.ok) {
        throw new Error(`${rebuilt.code}: ${rebuilt.message}`)
      }
      this.leafId = rebuilt.history.leafId
    }
    conn.onEvent((record) => this.handlePiRecord(record as Record<string, unknown>))
    conn.onExit(() => this.handleExit())
    void this.optionsState.catalog(conn, PI_CATALOG_LOOKUP_TIMEOUT_MS).catch(() => null)
    return {
      piSessionId,
      leafId: this.leafId,
      resumed,
      sessionFile: this.sessionFile,
      model: this.optionsState.model,
      thinkingLevel: this.optionsState.thinkingLevel,
      pid: this.child?.pid
    }
  }

  async close(graceMs?: number): Promise<boolean> {
    const conn = this.conn
    if (!conn || this.closed) {
      return true
    }
    this.closing = true
    try {
      this.optionsState.retireAllPrompts()
      this.translator.resetAll()
      this.activeOp = null
      this.pendingImmediate = null
      const result = await conn.close(graceMs ?? this.closeGrace)
      const exitObserved = result.exitCode !== null || result.signal !== null
      const sweep = this.child
        ? await terminatePiProcessTree(this.child, { detached: process.platform !== 'win32' })
        : false
      const pidAbsent = this.child?.pid !== undefined ? isPiPidAbsent(this.child.pid) : false
      if (exitObserved && sweep && pidAbsent) {
        this.closed = true
        this.conn = null
        return true
      }
      if (exitObserved) {
        throw new PiRootExitObservedError(
          `Pi root exited (code=${String(result.exitCode)} signal=${String(result.signal)}) but its tree could not be verified`
        )
      }
      return false
    } finally {
      this.closing = false
    }
  }

  async getSessionFile(): Promise<string | null> {
    if (this.sessionFile) {
      return this.sessionFile
    }
    const conn = this.conn
    if (!conn || conn.isClosed) {
      return null
    }
    try {
      const state = await conn.getState({ timeoutMs: this.optionTimeout })
      if (typeof state.sessionFile === 'string' && state.sessionFile !== '') {
        this.sessionFile = state.sessionFile
        return this.sessionFile
      }
    } catch {
      // Fall through to session stats below.
    }
    try {
      const stats = await conn.getSessionStats({ timeoutMs: this.optionTimeout })
      if (typeof stats.sessionFile === 'string' && stats.sessionFile !== '') {
        this.sessionFile = stats.sessionFile
        return this.sessionFile
      }
    } catch {
      return null
    }
    return null
  }

  protected requireLive(): PiRpcConnection {
    const conn = this.conn
    if (!conn || conn.isClosed || this.closed) {
      throw new Error('pi-exited (reacquire the session)')
    }
    return conn
  }

  protected handleExit(): void {
    if (this.closing) {
      return
    }
    this.optionsState.retireAllPrompts()
    try {
      this.deps.onUnexpectedExit?.(this.orcaSessionId)
    } catch {
      // Listener errors never break connection teardown; close() settles state.
    }
  }

  protected async refreshSessionFile(): Promise<void> {
    try {
      await this.getSessionFile()
    } catch {
      // Best-effort only; the cached file (if any) stands.
    }
  }
}
