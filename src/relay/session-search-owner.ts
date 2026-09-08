import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  closeSync,
  openSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import Database from '../main/sqlite/sync-database'
import { hardenSecurePath, writeDurableSecureJsonFile } from '../shared/secure-file'
import { restrictWindowsPathSync } from '../shared/secure-path-windows-acl'
import {
  SessionSearchService,
  type SessionSearchScanRoots
} from '../main/ai-vault-search/session-search-service'
import { sessionSearchCapability } from '../main/ai-vault-search/session-search-capability'
import {
  DEFAULT_AI_VAULT_SEARCH_SETTINGS,
  type AiVaultSearchSettings,
  type AiVaultSearchIndexStatus
} from '../shared/ai-vault-search-settings'
import {
  SessionSearchConfigureSchema,
  SessionSearchQuerySchema,
  type SessionSearchConfigure
} from '../shared/ai-vault-search-contract'
import { throwIfSignalAborted } from '../shared/abort-signal-reason'
import { projectSessionSearchResult } from '../shared/ai-vault-search-projection'

/** Account-local ownership; SQLite releases the exclusion lock even after a child crash. */
export class RelaySessionSearchOwner {
  private service: SessionSearchService | null = null
  private lock: Database | null = null
  private policy: AiVaultSearchSettings = DEFAULT_AI_VAULT_SEARCH_SETTINGS
  private chain: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private disposed = false
  private applicationError: string | undefined
  private readonly directory: string
  private readonly roots: SessionSearchScanRoots

  constructor(
    private readonly home: string,
    options: { directory?: string; roots?: SessionSearchScanRoots } = {}
  ) {
    if (!options.roots && home !== homedir()) {
      throw new Error('Search source home does not match the relay account.')
    }
    this.directory = options.directory ?? join(home, '.orca', 'session-search-relay')
    this.roots = options.roots ?? {
      wslHomeDirs: [],
      additionalCodexSessionsDirs: [
        join(home, '.local', 'share', 'orca', 'codex-runtime-home', 'home', 'sessions')
      ]
    }
  }

  request(
    operation: 'query' | 'status' | 'configure',
    raw: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.serialize(async () => {
      throwIfSignalAborted(signal)
      if (this.disposed) {
        throw new Error('Search owner is closed.')
      }
      const capability = sessionSearchCapability()
      if (operation === 'status' && !this.lock) {
        this.policy = this.readPolicy()
        // An existing owner's effective policy is only observable while holding the lock.
        if (!existsSync(join(this.directory, 'owner.sqlite'))) {
          return this.status(capability.available, capability.reason)
        }
      }
      if (!capability.available) {
        if (operation === 'status') {
          return this.status(false, capability.reason)
        }
        throw new Error(capability.reason)
      }
      this.acquire()
      try {
        if (operation === 'status') {
          return this.status(true)
        }
        if (operation === 'configure') {
          const args = SessionSearchConfigureSchema.parse(raw)
          await this.configure(args)
          return this.status(true)
        }
        const query = SessionSearchQuerySchema.parse(raw)
        this.service ??= this.createService()
        const result = await this.service.search(query, this.roots, signal)
        return projectSessionSearchResult(result)
      } catch (error) {
        await this.release()
        throw error
      }
    })
  }

  private get databasePath(): string {
    return join(this.directory, 'index.sqlite')
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.catch(() => undefined).then(run)
    this.chain = result
    return result
  }

  private readPolicy(): AiVaultSearchSettings {
    const file = join(this.directory, 'policy.json')
    if (!existsSync(file)) {
      return { ...DEFAULT_AI_VAULT_SEARCH_SETTINGS }
    }
    this.assertOwned(file, false)
    if (statSync(file).size > 8192) {
      throw new Error('Search policy exceeds its size limit.')
    }
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (saved.home !== this.home || saved.sources !== 1) {
      throw new Error('Search source configuration changed; host policy must be reviewed.')
    }
    const policy = SessionSearchConfigureSchema.parse(saved.policy)
    if (typeof policy.enabled !== 'boolean' || policy.historyDays === undefined) {
      throw new Error('Invalid search policy.')
    }
    return {
      enabled: policy.enabled,
      historyDays: policy.historyDays,
      ...(policy.paused ? { paused: true } : {})
    }
  }

  private assertOwned(path: string, directory: boolean): void {
    const stat = lstatSync(path)
    if (
      stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error('Unsafe search owner path.')
    }
  }

  private acquire(): void {
    if (this.lock) {
      return
    }
    if (existsSync(dirname(this.directory))) {
      this.assertOwned(dirname(this.directory), true)
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.assertOwned(this.directory, true)
    if (process.platform === 'win32') {
      if (!restrictWindowsPathSync(this.directory, true)) {
        throw new Error('Could not secure the host search directory.')
      }
    } else {
      hardenSecurePath(this.directory, {
        isDirectory: true,
        platform: process.platform,
        sync: true
      })
    }
    const path = join(this.directory, 'owner.sqlite')
    try {
      closeSync(openSync(path, 'wx', 0o600))
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    }
    this.assertOwned(path, false)
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const file = `${this.databasePath}${suffix}`
      if (existsSync(file)) {
        this.assertOwned(file, false)
      }
    }
    const lock = new Database(path, { timeout: 0 })
    try {
      lock.exec('BEGIN EXCLUSIVE')
    } catch {
      lock.close()
      throw new Error(
        'Search index is in use by another relay. Retry after its current indexing pass completes.'
      )
    }
    this.lock = lock
    try {
      this.policy = this.readPolicy()
    } catch (error) {
      this.lock = null
      lock.close()
      throw error
    }
    // Do not extend on traffic: a newer relay generation must get a chance to acquire.
    this.timer = setTimeout(() => {
      void this.serialize(() => this.yieldBackfill()).catch(() => undefined)
    }, 5_000)
    this.timer.unref?.()
  }

  private async configure(args: SessionSearchConfigure): Promise<void> {
    const next: AiVaultSearchSettings = {
      enabled: args.enabled ?? this.policy.enabled,
      historyDays: args.historyDays === undefined ? this.policy.historyDays : args.historyDays,
      ...((args.paused ?? this.policy.paused) ? { paused: true } : {})
    }
    try {
      // Configuration must remain usable even when the existing index cannot be opened.
      this.service ??= this.createService(false)
      await this.service.configure(next, this.roots, { clearIndex: args.clearIndex })
      if (
        !writeDurableSecureJsonFile(join(this.directory, 'policy.json'), {
          home: this.home,
          sources: 1,
          policy: next
        })
      ) {
        throw new Error('Could not secure the host search policy.')
      }
      this.policy = next
      this.applicationError = undefined
    } catch (error) {
      this.applicationError =
        error instanceof Error ? error.message : 'Search configuration failed.'
      throw error
    }
  }

  private createService(enabled = this.policy.enabled): SessionSearchService {
    try {
      const service = new SessionSearchService({
        databasePath: this.databasePath,
        ...this.policy,
        enabled
      })
      this.applicationError = undefined
      return service
    } catch (error) {
      this.applicationError =
        error instanceof Error ? error.message : 'Search initialization failed.'
      throw error
    }
  }

  private status(available: boolean, reason?: string): AiVaultSearchIndexStatus {
    let indexSizeBytes: number | null = null
    if (existsSync(this.databasePath)) {
      indexSizeBytes = ['', '-wal', '-shm', '-journal'].reduce((bytes, suffix) => {
        try {
          return bytes + statSync(`${this.databasePath}${suffix}`).size
        } catch {
          return bytes
        }
      }, 0)
    }
    return {
      ...this.policy,
      available,
      applied: available && !this.applicationError,
      indexSizeBytes,
      ...((reason ?? this.applicationError) ? { reason: reason ?? this.applicationError } : {})
    }
  }

  private async release(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    try {
      await this.service?.close()
    } finally {
      this.service = null
      this.lock?.close()
      this.lock = null
    }
  }

  private async yieldBackfill(): Promise<void> {
    const service = this.service
    if (service?.coverage().backfill === 'running') {
      // Finish discovery and parsing before handoff; restarting either can starve large histories.
      void service
        .ensureBackfill(this.roots)
        .then(() =>
          this.serialize(async () => {
            if (this.service === service) {
              await this.yieldBackfill()
            }
          })
        )
        .catch(() => undefined)
      return
    }
    await this.release()
  }

  async close(): Promise<void> {
    this.disposed = true
    await this.serialize(() => this.release())
  }
}
