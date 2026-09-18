// Shared types for the external bridge host family.
//
// Split from `bridge-host` (line budget): options, results, and envelopes shared by the
// transport/supervision/requests layers.

import type { SpawnedProcess } from '../../../../shared/child-process/run-process';
import type {
  BridgeCapabilities,
  BridgeProviderEvent,
  BridgeProviderIdentity,
  BridgeSessionMetadata,
  DispatchStatus,
} from './bridge-protocol';

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: string[]; cwd?: string; env?: NodeJS.ProcessEnv },
) => SpawnedProcess;

export type BridgeHostOptions = {
  /** Explicit dev-only provider command (e.g. `node`). Never from the plugin manifest. */
  bridgeCommand: string;
  bridgeArgs?: string[];
  /** Orca-selected workspace root forwarded as opaque cwd context (no secrets). */
  workspaceRoot: string;
  cwd?: string;
  /** Explicit env overlay for spawn only; never sent over the bridge. */
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** EOF grace for graceful shutdown (default 2000ms). Also bounds SIGTERM/SIGKILL stages unless killGraceMs overrides. */
  closeGraceMs?: number;
  /** Grace per kill stage (SIGTERM wait, then SIGKILL wait). Defaults to closeGraceMs. Every stage is bounded; teardown never hangs. */
  killGraceMs?: number;
  maxStderrBytes?: number;
  hostVersion?: string;
}

export type BridgeSupport = {
  available: boolean;
  reason: string;
  provider?: BridgeProviderIdentity;
  capabilities?: BridgeCapabilities;
}

export type AcquireResult = {
  sessionId: string;
  resumed: boolean;
  metadata: BridgeSessionMetadata;
}

export type DispatchOutcome = {
  status: DispatchStatus;
  opId: string;
  reason?: string;
}

export type SessionEventEnvelope = {
  sessionId: string;
  opId?: string;
  event: BridgeProviderEvent;
}

export type LifecycleEnvelope = {
  kind: "provider-exit" | "provider-error" | "bridge-closed";
  message: string;
  code?: string | number | null;
  signal?: string | null;
}

export function sanitizeReason(message: string): string {
  // Keep reasons short and free of prompt/env values: callers pass only
  // codes + opIds, never message text. Truncate defensively.
  const clean = message.replace(/[\r\n]+/g, " ").trim();
  return clean.length > 220 ? `${clean.slice(0, 217)}...` : clean;
}
