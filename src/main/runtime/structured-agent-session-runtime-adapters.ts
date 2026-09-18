// Provider-adapter assembly for the structured agent-session runtime.
//
// Split from `structured-agent-session-runtime` (line budget): per-provider construction
// (Codex launch resolver + adapter, Claude runtime adapter, Pi RPC backend + adapter).
// Recovery serialization and the late-settlement sink stay with the installer; builders
// receive them as callbacks so this file never reaches back into the runtime slot.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
import type { CodexStructuredPermissionPolicy } from '../codex/codex-structured-permission-policy'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredSessionAdapterDeps
} from '../codex/codex-structured-session-adapter'
import type {
  ClaudeStructuredSessionAdapter,
  ClaudeStructuredSessionAdapterDeps
} from '../claude/claude-structured-session-adapter'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import {
  readClaudeManagedAccountGateSettings,
  type ClaudeManagedAccountGateSettings
} from '../native-chat/claude-structured-managed-account-support'
import { createStructuredClaudeRuntimeAdapter } from './structured-claude-runtime-adapter'
import { PiStructuredSessionAdapter } from '../pi/pi-structured-session-adapter'
import { createPiRpcBackend, type PiRpcBackendDeps } from '../pi/pi-rpc-backend'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from './agent-session-record-store'

export function buildCodexStructuredAdapter(args: {
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  resolvePermissionPolicy?: () => CodexStructuredPermissionPolicy
  resolveCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  openConnection?: CodexStructuredSessionAdapterDeps['openConnection']
  readProcessStartTime?: CodexStructuredSessionAdapterDeps['readProcessStartTime']
  onBackgroundTasksChanged: CodexStructuredSessionAdapterDeps['onBackgroundTasksChanged']
  onDispatchSettledLate: CodexStructuredSessionAdapterDeps['onDispatchSettledLate']
  onEvent: CodexStructuredSessionAdapterDeps['onEvent']
}): CodexStructuredSessionAdapter {
  return new CodexStructuredSessionAdapter({
    resolveLaunch: createCodexStructuredLaunchResolver({
      store: args.store,
      resolveWorkspacePath: args.resolveWorkspacePath,
      resolveEnvironment: args.resolveEnvironment,
      ...(args.resolvePermissionPolicy
        ? { resolvePermissionPolicy: args.resolvePermissionPolicy }
        : {}),
      ...(args.resolveCommand ? { resolveCommand: args.resolveCommand } : {})
    }),
    ...(args.openConnection ? { openConnection: args.openConnection } : {}),
    ...(args.readProcessStartTime ? { readProcessStartTime: args.readProcessStartTime } : {}),
    onBackgroundTasksChanged: args.onBackgroundTasksChanged,
    onDispatchSettledLate: args.onDispatchSettledLate,
    onEvent: args.onEvent
  })
}

export function buildClaudeStructuredAdapter(args: {
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveClaudeCommand?: () => string
  resolveClaudeLaunchEnv?: () => Promise<Record<string, string>> | Record<string, string>
  resolveClaudeAuthPolicy: () => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  resolveClaudePermissionMode?: () => Promise<PermissionMode> | PermissionMode
  getClaudeManagedAccountGateSettings?: () => ClaudeManagedAccountGateSettings
  openClaudeConnection?: ClaudeStructuredSessionAdapterDeps['openConnection']
  readProcessStartTime?: ClaudeStructuredSessionAdapterDeps['readProcessStartTime']
  onUnexpectedExit: (event: StructuredAgentSessionLifecycleEvent) => void
  onBackgroundTasksChanged?: (
    sessionId: string,
    state: AgentSessionBackgroundTaskState | null
  ) => void
  onDispatchSettledLate?: ClaudeStructuredSessionAdapterDeps['onDispatchSettledLate']
}): ClaudeStructuredSessionAdapter {
  return createStructuredClaudeRuntimeAdapter({
    store: args.store,
    resolveWorkspacePath: args.resolveWorkspacePath,
    ...(args.resolveClaudeCommand ? { resolveClaudeCommand: args.resolveClaudeCommand } : {}),
    ...(args.resolveClaudeLaunchEnv ? { resolveClaudeLaunchEnv: args.resolveClaudeLaunchEnv } : {}),
    resolveClaudeAuthPolicy: args.resolveClaudeAuthPolicy,
    ...(args.resolveClaudePermissionMode
      ? { resolveClaudePermissionMode: args.resolveClaudePermissionMode }
      : {}),
    ...(args.getClaudeManagedAccountGateSettings
      ? {
          readClaudeManagedAccountGate: () =>
            readClaudeManagedAccountGateSettings(args.getClaudeManagedAccountGateSettings!)
        }
      : {}),
    onUnexpectedExit: args.onUnexpectedExit,
    onBackgroundTasksChanged: args.onBackgroundTasksChanged,
    onDispatchSettledLate: args.onDispatchSettledLate,
    ...(args.openClaudeConnection ? { openClaudeConnection: args.openClaudeConnection } : {}),
    ...(args.readProcessStartTime ? { readProcessStartTime: args.readProcessStartTime } : {})
  })
}

export function buildPiStructuredAdapter(args: {
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveEnv: () => Promise<NodeJS.ProcessEnv>
  spawnImpl?: PiRpcBackendDeps['spawnImpl']
  readProcessStartTime?: CodexStructuredSessionAdapterDeps['readProcessStartTime']
  onEvent: (event: StructuredAgentSessionLifecycleEvent) => void
}): PiStructuredSessionAdapter {
  let pi: PiStructuredSessionAdapter | null = null
  const piBackend = createPiRpcBackend({
    ...(args.spawnImpl ? { spawnImpl: args.spawnImpl } : {}),
    resolveEnv: args.resolveEnv,
    ...(args.readProcessStartTime ? { readProcessStartTime: args.readProcessStartTime } : {}),
    onUnexpectedExit: (sessionId) => pi?.publishUnexpectedExit(sessionId)
  })
  pi = new PiStructuredSessionAdapter({
    resolveWorkspacePath: args.resolveWorkspacePath,
    ...(args.readProcessStartTime ? { readProcessStartTime: args.readProcessStartTime } : {}),
    backend: piBackend,
    onEvent: args.onEvent
  })
  return pi
}
