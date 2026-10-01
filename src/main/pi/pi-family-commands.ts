// Pi-family command-discovery dialect (PIF-7, 44madfire/orca#28).
//
// Intentional dialect, not a common wire command: Pi serves `get_commands`
// while OMP serves `get_available_commands` plus pushed
// `available_commands_update` frames. Both normalize into Orca's existing
// `AgentSessionSlashCommand` model; provider-only metadata (aliases, input
// schemas, subcommands, sources) is dropped unless Orca already has a field.
// Unknown metadata is ignored safely; no fake `get_commands` alias is added
// to OMP.

import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import type { PiFamilyProvider } from './rpc/pi-family-rpc-types'
import type { PiCommandInfo } from './rpc/pi-wire-protocol'

const MAX_COMMANDS = 512
const MAX_NAME_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 200

function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const name = value.trim()
  if (name === '' || name.length > MAX_NAME_LENGTH || /\s/u.test(name)) {
    return undefined
  }
  return name
}

function cleanDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  if (collapsed === '' || collapsed.length > MAX_DESCRIPTION_LENGTH) {
    return undefined
  }
  return collapsed
}

function normalizeEntries(entries: readonly unknown[]): AgentSessionSlashCommand[] {
  const seen = new Set<string>()
  const out: AgentSessionSlashCommand[] = []
  for (const entry of entries) {
    if (out.length >= MAX_COMMANDS) {
      break
    }
    if (!entry || typeof entry !== 'object') {
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard above leaves only non-null objects; the index read below is bounded by cleanName/cleanDescription.
    const record = entry as Record<string, unknown>
    const name = cleanName(record['name'])
    if (name === undefined || seen.has(name)) {
      continue
    }
    seen.add(name)
    const description = cleanDescription(record['description'])
    out.push({
      name,
      kind: 'command',
      ...(description === undefined ? {} : { description })
    })
  }
  return out
}

/** Pi `get_commands` entries; extra provider fields never leak. */
export function normalizePiCommands(
  commands: readonly PiCommandInfo[]
): AgentSessionSlashCommand[] {
  return normalizeEntries(commands)
}

/** OMP `get_available_commands` / `available_commands_update` payloads. */
export function normalizeOmpCommands(commands: unknown): AgentSessionSlashCommand[] {
  return Array.isArray(commands) ? normalizeEntries(commands) : []
}

/** True for an OMP pushed catalog frame; Pi never emits this type. */
export function isOmpAvailableCommandsUpdate(record: Record<string, unknown>): boolean {
  return record['type'] === 'available_commands_update' && Array.isArray(record['commands'])
}

export type PiFamilyCommandConnection = {
  readonly familyProvider: PiFamilyProvider
  getCommands(opts?: { timeoutMs?: number }): Promise<{ commands: PiCommandInfo[] }>
  request<T>(command: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>
}

/** Pull the live catalog over the correct dialect wire command. */
export async function readPiFamilyCommandCatalog(
  conn: PiFamilyCommandConnection,
  timeoutMs: number
): Promise<AgentSessionSlashCommand[]> {
  if (conn.familyProvider === 'omp') {
    const data = await conn.request<{ commands: unknown }>(
      { type: 'get_available_commands' },
      { timeoutMs }
    )
    return normalizeOmpCommands(data?.commands)
  }
  const data = await conn.getCommands({ timeoutMs })
  return normalizePiCommands(data?.commands ?? [])
}

/** Per-session normalized catalog: pull at acquire, OMP push refresh on the normal event path. */
export class PiFamilyCommandCatalog {
  private entries: AgentSessionSlashCommand[] | undefined

  snapshot(): AgentSessionSlashCommand[] | undefined {
    return this.entries ? [...this.entries] : undefined
  }

  async refresh(
    conn: PiFamilyCommandConnection,
    timeoutMs: number
  ): Promise<AgentSessionSlashCommand[] | undefined> {
    try {
      this.entries = await readPiFamilyCommandCatalog(conn, timeoutMs)
    } catch {
      this.entries = undefined
    }
    return this.snapshot()
  }

  observePush(record: Record<string, unknown>, provider: PiFamilyProvider): void {
    if (provider === 'omp' && isOmpAvailableCommandsUpdate(record)) {
      this.entries = normalizeOmpCommands(record['commands'])
    }
  }
}
