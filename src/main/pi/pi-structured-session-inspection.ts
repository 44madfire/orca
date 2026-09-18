// Pi structured-session inspection surface: options and history resume.
//
// Split from `pi-structured-session-adapter` (line budget). Operates on the adapter's
// session map and failure ledger by reference; the adapter keeps thin delegations so
// the `StructuredAgentSessionAdapter` surface is unchanged.

import type {
  PiSession,
  PiStructuredBackend,
  PiStructuredSessionAdapterDeps
} from './pi-structured-backend'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionSetOptionInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

const PI_OPTION_KEYS = new Set(['model', 'thinkingLevel', 'queueMode', 'autoCompaction'])

export type PiStructuredSessionInspectionState = {
  sessions: Map<string, PiSession>
  failures: Map<string, Set<string>>
  deps: PiStructuredSessionAdapterDeps
  live: (sessionId: string) => PiSession
}

function requireInspectionBackend(deps: PiStructuredSessionAdapterDeps): PiStructuredBackend {
  const backend = deps.backend
  if (!backend) {
    throw new Error('PI_STRUCTURED_UNAVAILABLE: native Pi backend is not configured')
  }
  return backend
}

function trackRestoreFailure(
  failures: Map<string, Set<string>>,
  sessionId: string,
  key: string
): void {
  const seen = failures.get(sessionId) ?? new Set<string>()
  seen.add(key)
  failures.set(sessionId, seen)
}

export async function setPiSessionOption(
  state: PiStructuredSessionInspectionState,
  input: StructuredAgentSessionSetOptionInput
): Promise<void | Readonly<Record<string, string>>> {
  const session = state.live(input.sessionId)
  if (session.fence !== input.fence) {
    throw new Error('agent_session_checkpoint_stale')
  }
  if (!PI_OPTION_KEYS.has(input.key)) {
    trackRestoreFailure(state.failures, input.sessionId, input.key)
    throw new Error(`pi has no session option named ${input.key}`)
  }
  const set = requireInspectionBackend(state.deps).setOption
  if (!set) {
    trackRestoreFailure(state.failures, input.sessionId, input.key)
    throw new Error('Pi options are unavailable in this build.')
  }
  try {
    return await set({
      orcaSessionId: input.sessionId,
      key: input.key,
      value: input.value
    })
  } catch (error) {
    trackRestoreFailure(state.failures, input.sessionId, input.key)
    throw error
  }
}

export async function readPiSessionOptions(state: PiStructuredSessionInspectionState, input: {
  sessionId: string
  fence: number
}): Promise<{
  models: {
    id: string
    label: string
    isDefault: boolean
    defaultEffort?: string
    efforts: { value: string; label: string }[]
  }[]
  current: { model: string; effort?: string }
}> {
  const session = state.live(input.sessionId)
  if (session.fence !== input.fence) {
    throw new Error('agent_session_checkpoint_stale')
  }
  const backend = requireInspectionBackend(state.deps)
  const current = await backend.readOptions?.({ orcaSessionId: input.sessionId })
  const model = current?.model ?? 'pi'
  const effort = current?.thinkingLevel
  let models: {
    id: string
    label: string
    isDefault: boolean
    defaultEffort?: string
    efforts: { value: string; label: string }[]
  }[] = []
  try {
    const [catalog, levels] = await Promise.all([
      backend.listModels?.({ orcaSessionId: input.sessionId }) ?? Promise.resolve([]),
      backend.listThinkingLevels?.({ orcaSessionId: input.sessionId }) ?? Promise.resolve([])
    ])
    models = catalog.map((entry) => {
      const qualified = `${entry.provider}/${entry.id}`
      return {
        id: qualified,
        label: entry.id,
        isDefault: qualified === model || entry.id === model,
        ...(effort ? { defaultEffort: effort } : {}),
        efforts: levels.map((level) => ({ value: level, label: level }))
      }
    })
  } catch {
    models = []
  }
  return { models, current: { model, ...(effort ? { effort } : {}) } }
}

export function readPiOptionRestoreFailures(
  failures: Map<string, Set<string>>,
  sessionId: string
): readonly string[] {
  return [...(failures.get(sessionId) ?? [])]
}

export async function readPiResumeHistory(
  state: PiStructuredSessionInspectionState,
  input: { sessionId: string; fence: number }
): Promise<{
  rows: { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string }[]
  leafId: string | null
}> {
  const session = state.live(input.sessionId)
  if (session.fence !== input.fence) {
    throw new Error('agent_session_checkpoint_stale')
  }
  const read = requireInspectionBackend(state.deps).readResumeHistory
  if (!read) {
    throw new Error('Pi history resume is unavailable in this build.')
  }
  const rebuilt = await read({ orcaSessionId: input.sessionId })
  const rows: { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string }[] = []
  for (const row of rebuilt.rows) {
    const role = row.role
    if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') {
      rows.push({ id: row.id, role, text: row.text })
    }
  }
  return { rows, leafId: rebuilt.leafId }
}

export async function readPiHistoryFilePath(
  state: PiStructuredSessionInspectionState,
  input: { identity: AgentSessionJournalIdentity }
): Promise<string | null> {
  const session = state.sessions.get(input.identity.sessionId)
  if (session?.sessionFilePath) {
    return session.sessionFilePath
  }
  const backend = state.deps.backend
  if (!backend?.sessionFilePath || !session) {
    return null
  }
  return (await backend.sessionFilePath({ orcaSessionId: input.identity.sessionId })) ?? null
}
