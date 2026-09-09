/**
 * The structured half of worktree teardown.
 *
 * `killAllProcessesForWorktree` sweeps three PTY surfaces — the renderer graph, the provider's
 * session list, and the local pty-registry — and a structured agent session appears on NONE of
 * them. It has no PTY, no leaf, and no provider session row. So every sweep counted zero, no error
 * was raised, and removal deleted the checkout out from under a running provider child: the child
 * kept running with its `cwd` gone, the durable record and chat tab survived to republish at the
 * next launch pointing at a deleted worktree, and `worker-show` still reported the worker live.
 *
 * Membership is `location.workspaceId` PLUS the host fence below, and every structured session
 * carries both — so this covers a plain chat session in the worktree as well as a dispatched
 * worker. Liveness is `observeStructuredWorker`, the same `live` / `unverifiable` / `exited`
 * vocabulary the rest of the structured surface uses.
 *
 * `live` here is lease state — a provider child is attached — not work in flight, so it says
 * nothing about whether the user would lose anything. It selects what to CLOSE, never what to
 * refuse over: a removal refuses only on a close that did not settle, exactly as the PTY sweep
 * refuses only on a stop it could not verify.
 */

import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { STILL_LIVE_DETAIL_PREFIX } from '../../shared/worktree/removal'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { observeStructuredWorker } from './structured-worker-authority'
import { closeStructuredAgentSessionChild } from './structured-agent-session-close'
import type { OrcaRuntimeService } from './orca-runtime'

export type LiveStructuredSessionInWorkspace = {
  sessionId: string
  agent: 'claude' | 'codex'
}

export type UnclosedStructuredSession = LiveStructuredSessionInWorkspace & {
  /** Read AFTER the close: `live` is a child watched stay attached, not merely one left unproven. */
  status: 'live' | 'unverifiable'
}

export type StructuredWorktreeSweepRuntime = Pick<
  OrcaRuntimeService,
  'forgetStructuredSessionMail' | 'retireStructuredAgentSessionTabFromSnapshot'
>

/** The two fields every teardown caller already resolves to fence its PTY sweeps to one host. */
export type StructuredSessionHostFence = {
  resolvedConnectionId?: string
  resolvedRuntimeEnvironmentId?: string
}

/**
 * The one execution host this teardown may touch.
 *
 * A workspace id is `repoId::path` with no host component, so the local machine, an SSH host and a
 * paired runtime can all publish the SAME id and each names a DIFFERENT workspace (STA-4343). The
 * PTY sweeps fence on exactly these two fields; a structured session records its host directly, so
 * the comparison is on `location.executionHostId` instead of on a pty-id shape — but the
 * precedence is the same. Neither field set means the removal targets this machine, which is also
 * the safe default: a caller that resolved no host closes nothing on anyone else's.
 */
export function structuredSessionTeardownHostId(
  fence: StructuredSessionHostFence
): ExecutionHostId {
  if (fence.resolvedRuntimeEnvironmentId !== undefined) {
    return toRuntimeExecutionHostId(fence.resolvedRuntimeEnvironmentId)
  }
  return fence.resolvedConnectionId === undefined
    ? LOCAL_EXECUTION_HOST_ID
    : toSshExecutionHostId(fence.resolvedConnectionId)
}

/**
 * Structured sessions with a proven-live child in this worktree, on the fenced host only.
 *
 * An uninstalled host answers empty rather than throwing: no host in this generation means no
 * provider child was started by this process, and the three PTY sweeps fall through the same way
 * when their surface is unavailable. It is deliberately NOT read through the persisted store
 * directly — that would force-install the host, which is itself a side effect on a teardown path.
 */
export function listLiveStructuredSessionsForWorktree(
  worktreeId: string,
  fence: StructuredSessionHostFence
): LiveStructuredSessionInWorkspace[] {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return []
  }
  let records: ReturnType<typeof host.deps.store.listRecords>
  try {
    records = host.deps.store.listRecords()
  } catch {
    return []
  }
  const hostId = structuredSessionTeardownHostId(fence)
  return records
    .filter(
      (record) =>
        record.location.workspaceId === worktreeId &&
        record.location.executionHostId === hostId &&
        observeStructuredWorker({ sessionId: record.sessionId }).status === 'live'
    )
    .map((record) => ({ sessionId: record.sessionId, agent: record.provider }))
}

/**
 * Counts, providers and the post-close verdict — never session ids.
 *
 * A session id is one tab-id hop from the random pane key that gates a worker's mailbox, and this
 * string reaches agent-readable CLI output and a desktop toast. The count and the providers are
 * what a user deciding whether to force actually needs; the ids identify nothing they can act on.
 *
 * The verdict is here for the reason `describeUnstoppedPtys` carries one: "we watched it stay
 * attached" and "we could not confirm it went" are different decisions to waive, and the delete
 * toast branches on this marker. Any proven-live session makes the whole refusal a live one, as it
 * does for PTYs — that is the stronger warning, and the one whose work is about to be discarded.
 */
export function describeUnclosedStructuredSessions(
  sessions: readonly UnclosedStructuredSession[]
): string {
  const stillLive = sessions.filter((session) => session.status === 'live')
  const named = stillLive.length > 0 ? stillLive : sessions
  const noun = named.length === 1 ? 'agent session' : 'agent sessions'
  const providers = [...new Set(named.map((session) => session.agent))].sort().join(', ')
  const summary = `${named.length} ${noun} (${providers})`
  return stillLive.length > 0
    ? `${STILL_LIVE_DETAIL_PREFIX} ${summary}`
    : `could not confirm these closed: ${summary}`
}

/**
 * Closes the given structured sessions, and reports what stayed.
 *
 * Runs on the ordinary removal too, not just force: a child left running against a deleted `cwd` is
 * the outcome this whole sweep exists to prevent, and closing is how you prevent it. What stayed is
 * the only thing worth refusing over.
 *
 * Takes the list rather than re-deriving it, so the sessions reported as unclosed are exactly the
 * ones a close was attempted on — re-enumerating would run every liveness observation twice and
 * let the refusal name a session this call never touched.
 */
export async function closeStructuredSessionsForWorktree(
  sessions: readonly LiveStructuredSessionInWorkspace[],
  runtime?: StructuredWorktreeSweepRuntime
): Promise<{ closed: number; unstopped: UnclosedStructuredSession[] }> {
  // No `afterClose` for a dispatched worker: `host.close` drops the holds, so nothing keeps a
  // provider child un-evictable, but the dispatch's redrive subscription and registry entry do
  // survive until it settles by another verb. That is a bounded leak, not a hazard — and passing
  // one here would mean resolving a dispatch id per session on a teardown path that must stay
  // inside the sweep deadline.
  const unstopped: UnclosedStructuredSession[] = []
  let closed = 0
  for (const session of sessions) {
    const outcome = await closeStructuredAgentSessionChild(
      session.sessionId,
      runtime ? { runtime } : {}
    )
    if (outcome.stopped) {
      closed += 1
      continue
    }
    // Re-observed rather than reusing the close's own reason string: what the user is asked to
    // waive is the state AFTER the attempt, and a close that threw never reached an observation.
    const status = observeStructuredWorker({ sessionId: session.sessionId }).status
    unstopped.push({ ...session, status: status === 'live' ? 'live' : 'unverifiable' })
  }
  return { closed, unstopped }
}
