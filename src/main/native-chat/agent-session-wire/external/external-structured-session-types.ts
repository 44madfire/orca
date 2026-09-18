// Shared seam types for the external structured-session adapter family.
//
// Split from `external-structured-session-adapter` (line budget): the host and deps types
// live here so the acquire/options/turn-event modules can share them without a cycle back
// into the adapter.

import type { BridgeHost } from './bridge-host'

export type ExternalBridgeHostLike = Pick<
  BridgeHost,
  | 'probeSupport'
  | 'acquire'
  | 'release'
  | 'dispatch'
  | 'cancel'
  | 'answerPrompt'
  | 'setOptions'
  | 'getSession'
  | 'dispose'
  | 'onSessionEvent'
  | 'onLifecycle'
  | 'support'
> & { providerPid?: number | null }

export type ExternalAdapterDeps = {
  resolveWorkspacePath: (workspaceId: string) => Promise<string> | string
  readProcessStartTime?: (pid: number) => Promise<number | null> | number | null
  now?: () => number
  /** Injectable host factory (tests supply fakes; production uses BridgeHost). */
  createHost?: (options: {
    bridgeCommand: string
    bridgeArgs: string[]
    workspaceRoot: string
    env?: NodeJS.ProcessEnv
  }) => ExternalBridgeHostLike
  env?: NodeJS.ProcessEnv
  argv?: readonly string[]
  hostVersion?: string
}
