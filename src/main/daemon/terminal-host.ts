import type { Session } from './session'
import {
  SessionNotFoundError,
  type SessionInfo,
  type TakePendingOutputResult,
  type TerminalSnapshot
} from './types'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import type { TerminalHostOptions } from './terminal-host-options'
import { shutdownTerminalHostSessions } from './terminal-host-session-shutdown'
import { TerminalSessionTeardown } from './terminal-session-teardown'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import {
  createOrAttachClaimedAgentSession,
  type InternalCreateOrAttachOptions
} from './terminal-host-agent-session-claim'
import { TerminalHostAgentSessionGenerations } from './terminal-host-agent-session-generations'
import { resolveTerminalHostSessionCwd } from './terminal-host-session-cwd'
import { listLiveTerminalHostSessions } from './terminal-host-session-listing'
import { createOrAttachTerminalSession } from './terminal-host-session-create'
import { TerminalAttachCanceledError } from './daemon-errors'
import { rejectOnAbort } from './terminal-attach-cancellation'
import { randomUUID } from 'node:crypto'
import {
  inspectTerminalHostProcess,
  type TerminalHostProcessInspection
} from './terminal-host-process-inspection'
import {
  confirmTerminalHostForegroundProcess,
  confirmTerminalHostShellForeground,
  getSettledTerminalHostSnapshot,
  getTerminalHostAppliedSize,
  getTerminalHostPartialEscapeTail,
  getTerminalHostSnapshot,
  takeTerminalHostPendingOutput
} from './terminal-host-session-inspection-operations'

export type { CreateOrAttachOptions, CreateOrAttachResult } from './terminal-host-create-contract'

export type { TerminalHostOptions } from './terminal-host-options'

export class TerminalHost {
  private sessions = new Map<string, Session>()
  // Serializes creates for one id across async spawn validation.
  private pendingCreations = new Map<string, Promise<void>>()
  private sessionTeardown = new TerminalSessionTeardown(this.sessions)
  private spawnSubprocess: TerminalHostOptions['spawnSubprocess']
  private onSessionReaped: TerminalHostOptions['onSessionReaped']
  private reportReadinessEvent: TerminalHostOptions['reportReadinessEvent']
  private onFinalCheckpoint: TerminalHostOptions['onFinalCheckpoint']
  private creationFenced = false
  private disposePromise: Promise<void> | null = null
  private readonly agentSessionOwners = new ClaimedAgentPtyOwnerRegistry()
  private readonly agentSessionGenerations = new TerminalHostAgentSessionGenerations()
  private readonly authorityGeneration = randomUUID()
  private observationEpoch = 0

  constructor(opts: TerminalHostOptions) {
    this.spawnSubprocess = opts.spawnSubprocess
    this.onSessionReaped = opts.onSessionReaped
    this.reportReadinessEvent = opts.reportReadinessEvent
    this.onFinalCheckpoint = opts.onFinalCheckpoint
  }

  async createOrAttach(opts: InternalCreateOrAttachOptions): Promise<CreateOrAttachResult> {
    this.assertCreateOrAttachAllowed(opts)
    for (
      let inFlight = this.pendingCreations.get(opts.sessionId);
      inFlight !== undefined;
      inFlight = this.pendingCreations.get(opts.sessionId)
    ) {
      // Why: the create ahead of us can be stuck on an unreachable share for
      // minutes. Waiting unconditionally is what let one dead path strand every
      // later create and attach for the session, so a canceled caller leaves.
      await Promise.race([inFlight, rejectOnAbort(opts.cancelSignal, opts.sessionId)])
      this.assertCreateOrAttachAllowed(opts)
    }
    this.assertCreateOrAttachAllowed(opts)

    let settleCreation: () => void = () => {}
    this.pendingCreations.set(
      opts.sessionId,
      new Promise<void>((resolve) => {
        settleCreation = resolve
      })
    )
    try {
      return await createOrAttachClaimedAgentSession({
        options: opts,
        owners: this.agentSessionOwners,
        isLive: (owner) =>
          this.agentSessionGenerations.isCurrent(
            owner,
            Boolean(this.sessions.get(owner.ptyId)?.isAlive)
          ),
        createOrAttach: async (options) => {
          this.assertCreateOrAttachAllowed(options)
          if (options.agentSessionGeneration && this.sessions.get(options.sessionId)?.isAlive) {
            throw new Error('agent_session_claim_unavailable')
          }
          return await createOrAttachTerminalSession(options, {
            sessions: this.sessions,
            assertCreateAllowed: () => this.assertCreateOrAttachAllowed(options),
            sessionTeardown: this.sessionTeardown,
            spawnSubprocess: this.spawnSubprocess,
            onDeadSessionRemoved: (sessionId) => this.agentSessionGenerations.forget(sessionId),
            onSessionCreated: (sessionId, generation, isAlive) =>
              this.agentSessionGenerations.remember(sessionId, generation, isAlive),
            ...(this.reportReadinessEvent
              ? { reportReadinessEvent: this.reportReadinessEvent }
              : {}),
            onSessionExit: (sessionId, generation) => {
              this.agentSessionOwners.release(sessionId, generation)
              this.agentSessionGenerations.forget(sessionId, generation)
              this.reapSession(sessionId)
            }
          })
        }
      })
    } finally {
      this.pendingCreations.delete(opts.sessionId)
      settleCreation()
    }
  }

  private assertCreateOrAttachAllowed(opts: InternalCreateOrAttachOptions): void {
    if (this.creationFenced) {
      throw new Error('Terminal host is shutting down')
    }
    if (opts.isCanceled?.()) {
      throw new TerminalAttachCanceledError(opts.sessionId)
    }
  }

  write(sessionId: string, data: string): void {
    this.getAliveSession(sessionId).write(data)
  }

  closeStartupQueryAuthority(sessionId: string): number {
    return this.getAliveSession(sessionId).closeStartupQueryAuthority()
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.getAliveSession(sessionId).resize(cols, rows)
  }

  // Why null-not-throw (unlike write/resize): pause/resume are best-effort hints against a session that may have exited.
  pauseProducer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return
    }
    session.pauseProducer()
  }

  resumeProducer(sessionId: string): void {
    this.sessions.get(sessionId)?.resumeProducer()
  }

  kill(
    sessionId: string,
    opts: { immediate?: boolean; expectedIncarnationId?: string } = {}
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    // A caller naming an incarnation is acting on evidence about that process. The id may have
    // gone to a newer shell since, and that one is not theirs to end.
    if (
      session &&
      opts.expectedIncarnationId !== undefined &&
      session.incarnationId !== opts.expectedIncarnationId
    ) {
      throw new Error(`PTY incarnation mismatch for ${sessionId}`)
    }
    const pending = this.sessionTeardown.get(sessionId)
    if (pending) {
      return Promise.resolve(
        opts.immediate ? this.sessionTeardown.requestImmediate(sessionId) : pending
      )
    }
    if (session && !session.isAlive) {
      // The owner is done with a session that already ended on its own: its exit record has been
      // acted on, so it leaves now. This is the consume half of the held-exit read.
      this.sessions.delete(sessionId)
      return Promise.resolve()
    }
    const alive = this.getAliveSession(sessionId)
    return Promise.resolve(
      this.sessionTeardown.killSession(sessionId, alive, opts.immediate === true)
    )
  }

  // Why: dispose a dead session's emulator so exited terminals don't pin their scrollback window for
  // the daemon's life. A session its owner asked to end has nothing left to tell, so its record goes
  // now. One that ended on its own is evidence its owner may not have received; that record leaves
  // when the owner recreates the id or the host is disposed.
  private reapSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.isAlive) {
      return
    }
    session.dispose()
    if (session.killRequested) {
      this.sessions.delete(sessionId)
    }
    this.onSessionReaped?.(sessionId)
  }

  signal(sessionId: string, sig: string): void {
    this.getAliveSession(sessionId).signal(sig)
  }

  detach(sessionId: string, token: symbol): void {
    this.detachClients([{ sessionId, token }])
  }

  detachClients(attachments: readonly { sessionId: string; token: symbol }[]): void {
    for (const { sessionId, token } of attachments) {
      this.sessions.get(sessionId)?.detachClient(token)
    }
  }

  async getCwd(sessionId: string): Promise<string | null> {
    return await resolveTerminalHostSessionCwd(this.getAliveSession(sessionId))
  }

  // Why: null-not-throw — fetched for the tab-bar icon, so a vanished pane should quietly yield "no agent".
  getForegroundProcess(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getForegroundProcess()
  }

  inspectProcess(
    sessionId: string,
    options?: { expectedIncarnationId?: string; steadyState?: boolean }
  ): Promise<TerminalHostProcessInspection> {
    const session = this.sessions.get(sessionId)
    // An exited record is evidence only for the incarnation the caller named; a caller naming a
    // different one, or none, proves nothing about this process and gets the ordinary
    // missing-session failure (docs/reference/ssh-execution-boundary.md).
    const exitedSession =
      session &&
      !session.isAlive &&
      session.exitCode !== null &&
      session.incarnationId === options?.expectedIncarnationId
        ? { incarnationId: session.incarnationId, code: session.exitCode }
        : undefined
    if (!session?.isAlive && !exitedSession) {
      // Preserve the historical synchronous missing-session failure.
      throw new SessionNotFoundError(sessionId)
    }
    return inspectTerminalHostProcess({
      sessionId,
      session: session?.isAlive ? session : null,
      ...(options?.expectedIncarnationId
        ? { expectedIncarnationId: options.expectedIncarnationId }
        : {}),
      ...(options?.steadyState === true ? { steadyState: true } : {}),
      ...(exitedSession ? { exitedSession } : {}),
      authorityGeneration: this.authorityGeneration,
      nextObservationEpoch: () => ++this.observationEpoch
    })
  }

  async confirmForegroundProcess(sessionId: string): Promise<string | null> {
    return confirmTerminalHostForegroundProcess(this.sessions.get(sessionId))
  }

  async confirmShellForeground(sessionId: string): Promise<boolean> {
    return confirmTerminalHostShellForeground(this.sessions.get(sessionId), () =>
      this.sessions.get(sessionId)
    )
  }

  clearScrollback(sessionId: string): void {
    this.getAliveSession(sessionId).clearScrollback()
  }

  // Why: null-not-throw (unlike getAliveSession) — checkpoint is best-effort against a session that may have just exited.
  getSnapshot(sessionId: string, opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    return getTerminalHostSnapshot(this.sessions.get(sessionId), opts)
  }

  async getSettledSnapshot(
    sessionId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<TerminalSnapshot | null> {
    return getSettledTerminalHostSnapshot(this.sessions.get(sessionId), opts)
  }

  // Why: scan-authority handoff seed (null-not-throw like getSnapshot) — emulator's dangling incomplete escape at the stream position.
  getPartialEscapeTailAnsi(sessionId: string): string {
    return getTerminalHostPartialEscapeTail(this.sessions.get(sessionId))
  }

  // Why: renderer diffs this against xterm to detect a dropped/coerced daemon-side resize; null-not-throw like getSnapshot.
  getAppliedSize(sessionId: string): { cols: number; rows: number } | null {
    return getTerminalHostAppliedSize(this.sessions.get(sessionId))
  }

  // Why: null-not-throw like getSnapshot — incremental checkpoints are best-effort against a just-exited session.
  takePendingOutput(
    sessionId: string,
    includeSnapshot: boolean,
    opts: { teardownSnapshot?: boolean } = {}
  ): TakePendingOutputResult | null {
    return takeTerminalHostPendingOutput(this.sessions.get(sessionId), includeSnapshot, opts)
  }

  listSessions(): SessionInfo[] {
    return listLiveTerminalHostSessions(this.sessions, this.agentSessionOwners)
  }

  dispose(): Promise<void> {
    this.creationFenced = true
    if (this.disposePromise) {
      return this.disposePromise
    }
    const disposePromise = this.disposeSessions()
    this.disposePromise = disposePromise
    void disposePromise.catch(() => {
      // Why: keep failed native owners retryable on a later shutdown request.
      if (this.disposePromise === disposePromise) {
        this.disposePromise = null
      }
    })
    return disposePromise
  }

  private async disposeSessions(): Promise<void> {
    if (this.pendingCreations.size > 0) {
      // No spawn may publish a session after teardown completes.
      await Promise.all(this.pendingCreations.values())
    }
    await shutdownTerminalHostSessions(this.sessions, this.onFinalCheckpoint)
  }

  private getAliveSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      throw new SessionNotFoundError(sessionId)
    }
    return session
  }
}
