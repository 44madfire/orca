// Runtime installation for the SNC1.3 external dev seam (provider-neutral).
//
// Returns an `ExternalStructuredSessionAdapter` only when the explicit dev-only
// configuration is present (`--enable-external-structured-bridge` plus
// `ORCA_PI_BRIDGE_COMMAND`); otherwise returns null and the runtime keeps its
// production codex/claude pair untouched. Packaged Orca never sees this adapter.

import {
  ExternalStructuredSessionAdapter,
  type ExternalAdapterDeps,
} from './external-structured-session-adapter'
import { isExternalBridgeConfigured } from './external-structured-bridge-config'

export function createExternalStructuredSessionAdapterForRuntime(deps: {
  resolveWorkspacePath: ExternalAdapterDeps['resolveWorkspacePath']
  readProcessStartTime?: ExternalAdapterDeps['readProcessStartTime']
  env?: NodeJS.ProcessEnv
  argv?: readonly string[]
}): ExternalStructuredSessionAdapter | null {
  if (!isExternalBridgeConfigured(deps.env, deps.argv)) return null
  return new ExternalStructuredSessionAdapter({
    resolveWorkspacePath: deps.resolveWorkspacePath,
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.argv ? { argv: deps.argv } : {}),
  })
}
