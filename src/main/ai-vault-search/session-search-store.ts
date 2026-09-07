import { SessionSearchMaintenance } from './session-search-maintenance'
import { recoverSearchWrites } from './session-search-write-recovery'
import { deleteExpiredSearchFiles } from './session-search-retention-delete'
import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import { aiVaultSearchHistoryCutoffMs } from '../../shared/ai-vault-search-settings'
import type SyncDatabase from '../sqlite/sync-database'
import type {
  AiVaultSearchArgs,
  AiVaultSearchCoverage,
  AiVaultSearchProviderCoverage,
  AiVaultSearchResult
} from '../../shared/ai-vault-search-types'
import type {
  SessionSearchFileIdentity,
  SessionSearchIndexedFile,
  SessionSearchIndexSink,
  SessionSearchIndexWrite
} from '../ai-vault/session-search-capture'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { SessionSearchIndexWriter } from './session-search-index-writer'
import { SessionSearchQuery } from './session-search-query'
import { openSessionSearchDatabase } from './session-search-schema'

export type SessionSearchBackfillState = 'idle' | 'running' | 'complete'

type ProviderDiscovery = { files: number; parseFailures: number; scanIssues: number }

/** Owns the index database: the scanner writes through it, search reads from it. */
export class SessionSearchStore implements SessionSearchIndexSink {
  readonly streamingCapture = true
  /** Exposed for tests that assert on file-level state (page counts). */
  readonly db: SyncDatabase
  private readonly writer: SessionSearchIndexWriter
  private readonly query: SessionSearchQuery
  private backfill: SessionSearchBackfillState = 'idle'
  private closed = false
  private acceptingWrites = true
  private historyDays: number | null = null
  private providerCounts: { agent: AiVaultAgent; sessions: number; messages: number }[] | null =
    null
  private cleanupRequested = false
  private cleanup: Promise<void> | null = null
  private readonly maintenance: SessionSearchMaintenance
  private lastIndexedAt: string | null = null
  private applyFailures = 0
  private readonly stale = new Map<string, SessionFileCandidate>()
  private readonly discovery = new Map<AiVaultAgent, ProviderDiscovery>()

  constructor(
    path: string,
    private readonly onError: (error: unknown) => void = (error) =>
      console.warn(
        '[ai-vault-search] index write failed:',
        error instanceof Error ? error.name : 'IndexError'
      )
  ) {
    this.db = openSessionSearchDatabase(path)
    recoverSearchWrites(this.db)
    this.writer = new SessionSearchIndexWriter(this.db)
    this.query = new SessionSearchQuery(this.db)
    this.maintenance = new SessionSearchMaintenance(this.db, () => this.closed, this.onError)
  }

  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    try {
      return this.writer.indexedFile(path, identity)
    } catch (error) {
      this.onError(error)
      return null
    }
  }

  setAcceptingWrites(accept: boolean): void {
    this.acceptingWrites = accept
  }

  setHistoryDays(days: number | null): void {
    this.historyDays = days
    for (const [path, candidate] of this.stale) {
      if (!this.acceptsCandidate(candidate)) {
        this.stale.delete(path)
      }
    }
  }

  acceptsCandidate(candidate: SessionFileCandidate): boolean {
    const cutoff = aiVaultSearchHistoryCutoffMs(this.historyDays)
    return (
      !this.closed && this.acceptingWrites && (cutoff === null || candidate.file.mtimeMs >= cutoff)
    )
  }

  updateMetadata(candidate: SessionFileCandidate, session: AiVaultSession): void {
    if (!this.acceptsCandidate(candidate)) {
      return
    }
    try {
      this.writer.updateMetadata(candidate.file.path, session)
    } catch (error) {
      this.onError(error)
    }
  }

  async apply(update: SessionSearchIndexWrite): Promise<void> {
    if (!this.acceptsCandidate(update.candidate)) {
      return
    }
    this.providerCounts = null
    try {
      const applied = await this.writer.apply(
        update,
        () => this.acceptsCandidate(update.candidate),
        undefined,
        () => !this.closed
      )
      if (!applied) {
        this.markStale(update.candidate)
        return
      }
      this.providerCounts = null
      // Why: list scans queue every file the backfill has not reached yet; once
      // it lands, a later search must not re-parse the whole queue (8 s live).
      this.stale.delete(update.candidate.file.path)
      this.lastIndexedAt = new Date().toISOString()
    } catch (error) {
      this.markStale(update.candidate)
      this.applyFailures += 1
      this.onError(error)
    } finally {
      this.scheduleCleanup()
    }
  }

  markStale(candidate: SessionFileCandidate): void {
    if (this.acceptsCandidate(candidate)) {
      this.stale.set(candidate.file.path, candidate)
    }
  }

  /** Hands the stale set to the backfill lane and clears it. */
  takeStale(): SessionFileCandidate[] {
    const candidates = [...this.stale.values()]
    this.stale.clear()
    return candidates
  }

  get staleCount(): number {
    return this.stale.size
  }

  removeFile(path: string): void {
    this.providerCounts = null
    this.stale.delete(path)
    try {
      this.writer.removeFile(path)
      this.scheduleCleanup()
    } catch (error) {
      this.onError(error)
    }
  }

  private scheduleCleanup(): void {
    if (this.closed) {
      return
    }
    if (this.cleanup) {
      this.cleanupRequested = true
      return
    }
    this.cleanupRequested = false
    this.cleanup = deleteExpiredSearchFiles(
      this.db,
      null,
      () => this.closed,
      () => {
        this.providerCounts = null
      }
    )
      .catch((error) => {
        if (!this.closed) {
          this.onError(error)
        }
      })
      .finally(() => {
        this.cleanup = null
        if (this.cleanupRequested) {
          this.scheduleCleanup()
        }
      })
  }

  /** Hides expired sessions immediately, then removes their rows in resumable batches. */
  async purgeOlderThan(cutoffMs: number | null, signal?: AbortSignal): Promise<void> {
    try {
      await deleteExpiredSearchFiles(
        this.db,
        cutoffMs,
        () => this.closed || signal?.aborted === true,
        () => {
          this.providerCounts = null
        }
      )
      if (!this.closed && !signal?.aborted) {
        await this.maintenance.compact(signal)
      }
    } catch (error) {
      if (!this.closed) {
        this.onError(error)
      }
    }
  }

  warm(): Promise<void> {
    return this.maintenance.warm()
  }

  setBackfillState(state: SessionSearchBackfillState): void {
    this.backfill = state
  }

  /** What a full discovery pass saw, so a provider that indexed nothing is still visible. */
  setDiscovered(agent: AiVaultAgent, files: number, scanIssues: number): void {
    const entry = this.providerDiscovery(agent)
    entry.files = files
    entry.scanIssues = scanIssues
  }

  recordParseFailure(agent: AiVaultAgent): void {
    this.providerDiscovery(agent).parseFailures += 1
  }

  search(args: AiVaultSearchArgs): AiVaultSearchResult {
    const startedAt = performance.now()
    const execution = this.query.execute(args, aiVaultSearchHistoryCutoffMs(this.historyDays))
    const durationMs = performance.now() - startedAt
    this.maintenance.logQuery(args.query, execution.route, execution.hits.length, durationMs)
    return {
      hits: execution.hits,
      route: execution.route,
      ...(execution.repairedTerms ? { repairedTerms: execution.repairedTerms } : {}),
      durationMs,
      coverage: this.coverage()
    }
  }

  coverage(): AiVaultSearchCoverage {
    const providers = (this.providerCounts ??= this.db
      .prepare(
        `SELECT s.agent AS agent, COUNT(DISTINCT s.id) AS sessions, COUNT(m.id) AS messages
         FROM sessions s LEFT JOIN messages m ON m.session_row_id = s.id
           AND (m.batch_id IS NULL OR m.batch_id NOT IN (SELECT id FROM search_write_batches WHERE published=0))
         WHERE s.index_ready=1 AND s.id NOT IN (SELECT session_row_id FROM search_pending_deletes WHERE batch_id IS NULL)
         GROUP BY s.agent ORDER BY s.agent`
      )
      .all() as { agent: AiVaultAgent; sessions: number; messages: number }[])
    const indexed = new Map(providers.map((row) => [row.agent, row]))
    const agents = [...new Set([...indexed.keys(), ...this.discovery.keys()])].sort()
    const byProvider: AiVaultSearchProviderCoverage[] = agents.map((agent) => {
      const row = indexed.get(agent)
      const seen = this.discovery.get(agent)
      return {
        agent,
        sessionsIndexed: row?.sessions ?? 0,
        messagesIndexed: row?.messages ?? 0,
        ...(seen && seen.files > 0 ? { filesDiscovered: seen.files } : {}),
        ...(seen && seen.parseFailures > 0 ? { parseFailures: seen.parseFailures } : {}),
        ...(seen && seen.scanIssues > 0 ? { scanIssues: seen.scanIssues } : {})
      }
    })
    return {
      enabled: true,
      sessionsIndexed: byProvider.reduce((sum, row) => sum + row.sessionsIndexed, 0),
      messagesIndexed: byProvider.reduce((sum, row) => sum + row.messagesIndexed, 0),
      providers: byProvider,
      backfill: this.backfill,
      filesPending: this.stale.size,
      lastIndexedAt: this.lastIndexedAt
    }
  }

  get failures(): number {
    return this.applyFailures
  }

  close(): void {
    this.closed = true
    this.db.close()
  }

  private providerDiscovery(agent: AiVaultAgent): ProviderDiscovery {
    const existing = this.discovery.get(agent)
    if (existing) {
      return existing
    }
    const created: ProviderDiscovery = { files: 0, parseFailures: 0, scanIssues: 0 }
    this.discovery.set(agent, created)
    return created
  }
}
