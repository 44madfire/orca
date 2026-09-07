import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../shared/agent-session-wire'
import { isCodexAppServerRequestError } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'

/**
 * Codex's background terminals — the detached processes a turn spawns, which
 * outlive the turn. Interrupting a turn does not reap them; the app-server
 * exposes that as its own operation, and this is the only path to it.
 *
 * The operations are experimental upstream, so a host can answer any of them
 * with a refusal. `supported` starts null (never asked) and latches to false on
 * the first refusal, which keeps the client's Stop control hidden rather than
 * offering one that silently does nothing.
 */
export type CodexBackgroundTerminals = {
  supported: boolean | null
  state: AgentSessionBackgroundTaskState | null
}

type CodexBackgroundTerminalRow = {
  processId?: unknown
  command?: unknown
}

export function createCodexBackgroundTerminals(): CodexBackgroundTerminals {
  return { supported: null, state: null }
}

function readRows(response: unknown): CodexBackgroundTerminalRow[] {
  const data = (response as { data?: unknown } | null)?.data
  return Array.isArray(data) ? (data as CodexBackgroundTerminalRow[]) : []
}

function toTask(row: CodexBackgroundTerminalRow): AgentSessionBackgroundTask | null {
  const id = typeof row.processId === 'string' ? row.processId : null
  if (!id) {
    return null
  }
  return {
    id,
    // Always a shell command: the app-server's other background kinds do not
    // reach this list.
    kind: 'command',
    ...(typeof row.command === 'string' && row.command ? { description: row.command } : {})
  }
}

function toState(response: unknown): AgentSessionBackgroundTaskState | null {
  const tasks = readRows(response)
    .map(toTask)
    .filter((task): task is AgentSessionBackgroundTask => task !== null)
  // No terminals means nothing to monitor, which is the same shape the client
  // reads when the session ends.
  return tasks.length === 0 ? null : { state: 'monitoring', tasks, supportsTaskStop: true }
}

function statesEqual(
  left: AgentSessionBackgroundTaskState | null,
  right: AgentSessionBackgroundTaskState | null
): boolean {
  if (left === null || right === null) {
    return left === right
  }
  const leftTasks = left.tasks ?? []
  const rightTasks = right.tasks ?? []
  return (
    leftTasks.length === rightTasks.length &&
    leftTasks.every((task, index) => {
      const other = rightTasks[index]
      return task.id === other?.id && task.description === other.description
    })
  )
}

/**
 * Re-reads the live list. Returns true when the published state changed, so the
 * caller only wakes subscribers on a real transition.
 *
 * A refusal is a capability verdict, not a failure: it latches `supported` to
 * false and clears any state. Anything else (a dead child, a timeout) leaves the
 * verdict alone so a transient error cannot permanently hide the control.
 */
export async function refreshCodexBackgroundTerminals(
  terminals: CodexBackgroundTerminals,
  session: CodexSession,
  timeoutMs?: number
): Promise<boolean> {
  if (terminals.supported === false) {
    return false
  }
  let response: unknown
  try {
    response = await session.connection.request(
      'thread/backgroundTerminals/list',
      { threadId: session.threadId },
      { timeoutMs }
    )
  } catch (error) {
    if (isCodexAppServerRequestError(error)) {
      const had = terminals.state !== null
      terminals.supported = false
      terminals.state = null
      return had
    }
    return false
  }
  terminals.supported = true
  const next = toState(response)
  if (statesEqual(terminals.state, next)) {
    return false
  }
  terminals.state = next
  return true
}

/**
 * Stops one background terminal by id, or every one when no id is given.
 *
 * Reports `cancelled` only on a confirmed stop — a refusal here also latches the
 * capability off, because a host that cannot terminate must not keep showing a
 * Stop button.
 */
export async function stopCodexBackgroundTerminals(
  terminals: CodexBackgroundTerminals,
  session: CodexSession,
  timeoutMs?: number,
  taskId?: string
): Promise<{ cancelled: boolean }> {
  if (terminals.supported === false) {
    return { cancelled: false }
  }
  try {
    await (taskId
      ? session.connection.request(
          'thread/backgroundTerminals/terminate',
          { threadId: session.threadId, processId: taskId },
          { timeoutMs }
        )
      : session.connection.request(
          'thread/backgroundTerminals/clean',
          { threadId: session.threadId },
          { timeoutMs }
        ))
  } catch (error) {
    if (isCodexAppServerRequestError(error)) {
      terminals.supported = false
      terminals.state = null
    }
    return { cancelled: false }
  }
  return { cancelled: true }
}

export type CodexBackgroundTerminalChannel = {
  /** A turn is the only thing that spawns background terminals, so its end is
   *  the one moment the cached list can have changed. Fire-and-forget: a stale
   *  list must never delay or fail a turn. */
  observe: (
    session: CodexSession,
    event: { sessionId: string; threadId: string; method: string }
  ) => void
  state: (sessionId: string) => AgentSessionBackgroundTaskState | null | undefined
  stop: (input: {
    sessionId: string
    fence: number
    taskId?: string
  }) => Promise<{ cancelled: boolean }>
}

/** Owns the per-session cache, the capability verdict, and subscriber wake-ups. */
export function createCodexBackgroundTerminalChannel(deps: {
  sessions: Map<string, CodexSession>
  requestTimeoutMs?: number
  onChanged?: (sessionId: string, state: AgentSessionBackgroundTaskState | null) => void
}): CodexBackgroundTerminalChannel {
  const refresh = (sessionId: string, session: CodexSession): void => {
    void refreshCodexBackgroundTerminals(
      session.backgroundTerminals,
      session,
      deps.requestTimeoutMs
    )
      .then((changed) => {
        if (changed && deps.sessions.get(sessionId) === session) {
          deps.onChanged?.(sessionId, session.backgroundTerminals.state)
        }
      })
      // The refresh already swallows non-verdict failures; nothing to add.
      .catch(() => {})
  }
  return {
    observe: (session, event) => {
      if (event.method === 'turn/completed' && event.threadId === session.threadId) {
        refresh(event.sessionId, session)
      }
    },
    state: (sessionId) => deps.sessions.get(sessionId)?.backgroundTerminals.state,
    stop: async (input) => {
      const session = deps.sessions.get(input.sessionId)
      // Why the fence check: a stop aimed at a superseded child would report a
      // confirmed kill for terminals the current child still owns.
      if (!session || session.ended || session.fence !== input.fence) {
        return { cancelled: false }
      }
      const result = await stopCodexBackgroundTerminals(
        session.backgroundTerminals,
        session,
        deps.requestTimeoutMs,
        input.taskId
      )
      refresh(input.sessionId, session)
      return result
    }
  }
}
