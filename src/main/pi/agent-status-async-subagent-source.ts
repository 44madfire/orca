import type { PiAgentKind } from '../../shared/pi-agent-kind'

/** Async child runs delegated through pi's subagent extension outlive the parent turn: the parent
 *  settles and goes interactive while the children keep working. Their lifecycle rides pi's process
 *  event bus rather than the extension API, so it is forwarded here as its own hook event and folded
 *  into the pane's descendant roster receiver-side — the parent's own `agent_end` stays the parent's. */
export function getPiAgentStatusAsyncSubagentSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    '  // Why: a bus this pi build does not emit on simply never fires; registering costs nothing',
    '  // and keeps the parent-only path unchanged for installs without the subagent extension.',
    '  // pi reloads extensions in-process and re-runs this factory: pi.on handlers are replaced,',
    '  // but process-bus listeners accumulate, so bind at most once. Deliberately a BLOCK and not',
    '  // an early return — returning here would skip every handler registered after this point.',
    '  if (!piAsyncSubagentBusBound) {',
    '  try {',
    '    const bus = process as unknown as { on?: (event: string, listener: (payload: unknown) => void) => void }',
    '    const readRunId = (payload: unknown): string => {',
    "      if (!payload || typeof payload !== 'object') return ''",
    '      const record = payload as Record<string, unknown>',
    "      for (const key of ['runId', 'run_id', 'subagentId', 'subagent_id', 'id']) {",
    '        const value = record[key]',
    "        if (typeof value === 'string' && value) return value",
    '      }',
    "      return ''",
    '    }',
    '    const readText = (payload: unknown, keys: string[]): string | undefined => {',
    "      if (!payload || typeof payload !== 'object') return undefined",
    '      const record = payload as Record<string, unknown>',
    '      for (const key of keys) {',
    '        const value = record[key]',
    "        if (typeof value === 'string' && value) return value",
    '      }',
    '      return undefined',
    '    }',
    '    const postAsyncSubagent = (hookEventName: string, payload: unknown): void => {',
    '      if (isOmpRuntime()) return',
    '      const runId = readRunId(payload)',
    '      if (!runId) return',
    '      post(hookEventName, {',
    '        subagent_id: runId,',
    "        agent_type: readText(payload, ['agentType', 'agent_type', 'subagentType']),",
    "        description: readText(payload, ['description', 'task', 'prompt']),",
    '      })',
    '    }',
    "    bus.on?.('subagent:async-started', (payload) => postAsyncSubagent('subagent_async_started', payload))",
    "    bus.on?.('subagent:async-complete', (payload) => postAsyncSubagent('subagent_async_complete', payload))",
    '    piAsyncSubagentBusBound = true',
    '  } catch {',
    '    // Why: status reporting must never fail the pi run; an unavailable bus just means no children.',
    '  }',
    '  }',
    ''
  ]
}
