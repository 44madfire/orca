// Development-only external structured-session bridge configuration (SNC1.3).
//
// This is explicitly NOT part of the public plugin manifest and never ships in
// packaged Orca. It exists so Pi-specific structured-session logic can run out
// of process and be hot-swapped without rebuilding Electron for every change.
//
// Orca keeps ownership of journal, lease/fencing, outbox/idempotency,
// rendering, and client synchronization. The bridge only transports opaque
// provider events into the adapter's journal sink.
//
// Usage (dev shell only):
//   export ORCA_PI_BRIDGE_COMMAND="node /path/to/orca-pi/packages/structured-bridge/dist/mock-provider-cli.js"
//   orca --enable-external-structured-bridge
//
// Missing/incompatible bridge → probeExternalBridgeSupport(){available:false}
// → caller keeps the ordinary Pi TUI path untouched.

export const EXTERNAL_BRIDGE_COMMAND_ENV = 'ORCA_PI_BRIDGE_COMMAND'
export const EXTERNAL_BRIDGE_FLAG = '--enable-external-structured-bridge'

export type ExternalBridgeConfig = {
  enabled: boolean
  command: string
  args: string[]
  reason: string
}

function parseCommand(command: string): { command: string; args: string[] } {
  const trimmed = command.trim()
  if (trimmed === '') return { command: '', args: [] }
  // Minimal whitespace split honoring single/double quotes (dev paths only,
  // never user input over the bridge). No shell expansion, no env interpolation.
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current !== '') {
        parts.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current !== '') parts.push(current)
  if (parts.length === 0) return { command: '', args: [] }
  const [head, ...rest] = parts as [string, ...string[]]
  return { command: head, args: rest }
}

/**
 * Read explicit dev-only bridge configuration. Never reads the plugin
 * manifest, never executes arbitrary public plugin processes.
 *
 * @param env process env (injectable for tests; defaults to process.env)
 * @param argv process argv (injectable for tests; defaults to process.argv)
 */
export function readExternalBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): ExternalBridgeConfig {
  const enabled = argv.includes(EXTERNAL_BRIDGE_FLAG)
  const raw = (env[EXTERNAL_BRIDGE_COMMAND_ENV] ?? '').trim()
  if (!enabled) {
    return { enabled: false, command: '', args: [], reason: 'external-bridge-flag-absent' }
  }
  if (raw === '') {
    return {
      enabled: true,
      command: '',
      args: [],
      reason: `dev bridge flag present but ${EXTERNAL_BRIDGE_COMMAND_ENV} is empty`,
    }
  }
  const { command, args } = parseCommand(raw)
  if (command === '') {
    return {
      enabled: true,
      command: '',
      args: [],
      reason: `dev bridge command unparseable`,
    }
  }
  return { enabled: true, command, args, reason: 'external-bridge-configured' }
}

/** Fail-closed availability probe: false unless flag + parseable command. */
export function isExternalBridgeConfigured(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  const config = readExternalBridgeConfig(env, argv)
  return config.enabled && config.command !== ''
}
