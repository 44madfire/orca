import { randomBytes } from 'node:crypto'
import {
  MOBILE_WEB_TERMINAL_ARTIFACT_MAX_RECORDS,
  MOBILE_WEB_TERMINAL_ARTIFACT_TTL_MS
} from '../../../../shared/mobile-web/terminal-artifact-contract'

export type MobileWebTerminalArtifactRecord = {
  token: string
  connectionId: string
  worktree: string
  tabId: string
  terminal: string
  absolutePath: string
  grantId: string
  previewKind: 'text' | 'raster'
  expiresAt: number
}

/** Absolute host paths and terminal file grants never reach the page; it holds an opaque token
 *  that dies with its connection, its tab, or the TTL, whichever comes first. */
export class MobileWebTerminalArtifactStore {
  private readonly records = new Map<string, MobileWebTerminalArtifactRecord>()

  constructor(private readonly now: () => number = Date.now) {}

  retain(
    record: Omit<MobileWebTerminalArtifactRecord, 'token' | 'expiresAt'>
  ): MobileWebTerminalArtifactRecord {
    this.prune()
    for (const [token, candidate] of this.records) {
      if (candidate.connectionId === record.connectionId && candidate.tabId === record.tabId) {
        this.records.delete(token)
      }
    }
    // Insertion order is age order, so the first match is the oldest this connection still holds.
    for (const [token, candidate] of this.records) {
      if (this.countFor(record.connectionId) < MOBILE_WEB_TERMINAL_ARTIFACT_MAX_RECORDS) {
        break
      }
      if (candidate.connectionId === record.connectionId) {
        this.records.delete(token)
      }
    }
    const retained = {
      ...record,
      token: randomBytes(32).toString('base64url'),
      expiresAt: this.now() + MOBILE_WEB_TERMINAL_ARTIFACT_TTL_MS
    }
    this.records.set(retained.token, retained)
    return retained
  }

  require(target: {
    token: string
    connectionId: string
    tabId: string
  }): MobileWebTerminalArtifactRecord {
    this.prune()
    const record = this.records.get(target.token)
    if (!record || record.connectionId !== target.connectionId || record.tabId !== target.tabId) {
      throw new Error('selector_not_found')
    }
    return record
  }

  renew(record: MobileWebTerminalArtifactRecord): void {
    record.expiresAt = this.now() + MOBILE_WEB_TERMINAL_ARTIFACT_TTL_MS
  }

  release(token: string): void {
    this.records.delete(token)
  }

  releaseOwned(target: { token: string; connectionId: string; tabId: string }): void {
    const record = this.records.get(target.token)
    if (record && record.connectionId === target.connectionId && record.tabId === target.tabId) {
      this.records.delete(target.token)
    }
  }

  sizeForTests(): number {
    this.prune()
    return this.records.size
  }

  private countFor(connectionId: string): number {
    let count = 0
    for (const record of this.records.values()) {
      if (record.connectionId === connectionId) {
        count += 1
      }
    }
    return count
  }

  private prune(): void {
    const now = this.now()
    for (const [token, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(token)
      }
    }
  }
}
