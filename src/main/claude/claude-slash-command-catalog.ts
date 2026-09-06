import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'

// Init carries name arrays; reloads carry command descriptors instead.
const MAX_COMMANDS = 512
const MAX_NAME_LENGTH = 200

function names(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  for (const entry of value) {
    if (seen.size >= MAX_COMMANDS) {
      break
    }
    const name = typeof entry === 'string' ? entry.trim() : ''
    if (name.length > 0 && name.length <= MAX_NAME_LENGTH && !/\s/u.test(name)) {
      seen.add(name)
    }
  }
  return [...seen]
}

function carriesCommandCatalog(message: Record<string, unknown>): boolean {
  return (
    message.type === 'system' &&
    (message.subtype === 'init' || message.subtype === 'commands_changed') &&
    Array.isArray(message.slash_commands)
  )
}

/** What the session reports it can run, minus what it reserves for a terminal UI. */
export function readClaudeSlashCommands(
  message: Record<string, unknown>
): AgentSessionSlashCommand[] {
  // Why: the hide-list exists so a non-terminal UI like chat does not offer a
  // command that only means something inside the CLI's own TUI.
  const hidden = new Set(names(message.terminal_slash_commands))
  const skills = new Set(names(message.skills))
  return names(message.slash_commands)
    .filter((name) => !hidden.has(name))
    .map((name) => ({ name, kind: skills.has(name) ? ('skill' as const) : ('command' as const) }))
}

/** Per-session `/` catalog, seeded from the init frame that proved the session
 *  and refreshed by every later init or `commands_changed` frame. */
export class ClaudeSlashCommandCatalog {
  private entries: AgentSessionSlashCommand[] | undefined
  private hidden = new Set<string>()
  private commandNames = new Set<string>()

  constructor(initMessage?: Record<string, unknown>) {
    if (initMessage) {
      this.observe(initMessage)
    }
  }

  get commands(): AgentSessionSlashCommand[] | undefined {
    return this.entries
  }

  /** True when this frame replaced the catalog with a different one. */
  observe(message: Record<string, unknown>): boolean {
    let next: AgentSessionSlashCommand[]
    if (carriesCommandCatalog(message)) {
      this.hidden = new Set(names(message.terminal_slash_commands))
      next = readClaudeSlashCommands(message)
      this.commandNames = new Set(
        next.filter((entry) => entry.kind === 'command').map((entry) => entry.name)
      )
    } else if (
      message.type === 'system' &&
      message.subtype === 'commands_changed' &&
      Array.isArray(message.commands)
    ) {
      const descriptors = message.commands.filter(
        (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object'
      )
      next = names(descriptors.map((entry) => entry.name))
        .filter((name) => !this.hidden.has(name))
        .map((name) => ({ name, kind: this.commandNames.has(name) ? 'command' : 'skill' }))
    } else {
      return false
    }
    if (
      this.entries !== undefined &&
      next.length === this.entries.length &&
      next.every(
        (entry, index) =>
          entry.name === this.entries?.[index]?.name && entry.kind === this.entries?.[index]?.kind
      )
    ) {
      return false
    }
    this.entries = next
    return true
  }
}
