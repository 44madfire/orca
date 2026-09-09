import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { PANE_KEY } from '../../shared/agent-hook-listener-test-harness'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import {
  createAgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'

const HOOK_ENV = { ORCA_PANE_KEY: PANE_KEY, ORCA_AGENT_HOOK_ENV: 'production' }

/** Drives the REAL generated extension source into the REAL listener entry, so the pane state
 *  asserted here is the one a pi pane would actually show. */
function createHarness(kind: 'pi' | 'omp' | 'prime-agent' = 'pi') {
  const state = createHookListenerState()
  const states: (string | undefined)[] = []
  const harness = createAgentStatusExtensionHarness({
    kind,
    env: HOOK_ENV,
    fetchImpl: async (_url, init) => {
      const event = normalizeHookPayload(
        state,
        kind === 'prime-agent' ? 'prime-agent' : kind,
        JSON.parse(String(init?.body)),
        'production'
      )
      if (event) {
        state.lastStatusByPaneKey.set(PANE_KEY, event)
      }
      states.push(event?.payload.state)
      return { ok: true }
    }
  })
  return { ...harness, states }
}

async function flushPosts(): Promise<void> {
  // Why: `agent_end` defers its post through a 0ms idle recheck, so microtask flushes alone
  // would read the pane before the parent's own completion was ever delivered.
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function drive(
  harness: ReturnType<typeof createHarness>,
  name: string,
  event: unknown = {},
  context: HookContext = { isIdle: () => true }
): Promise<void> {
  await harness.callHook(name, event, context)
  await flushPosts()
}

async function emit(
  harness: ReturnType<typeof createHarness>,
  name: string,
  payload: unknown
): Promise<void> {
  harness.emitProcessBus(name, payload)
  await flushPosts()
}

describe('pi async subagent runs reach the pane as descendants (STA-6378)', () => {
  it('holds the pane working while an async child run outlives the parent turn', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'delegate the sweep' })
    await drive(harness, 'agent_start')
    await emit(harness, 'subagent:async-started', { runId: 'run-1', agentType: 'researcher' })

    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, 'subagent:async-complete', { runId: 'run-1' })
    expect(harness.states.at(-1)).toBe('done')
  })

  it('settles only after the last child, then only once for the turn it wakes', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'fan out' })
    await drive(harness, 'agent_start')
    await emit(harness, 'subagent:async-started', { runId: 'run-1' })
    await emit(harness, 'subagent:async-started', { runId: 'run-2' })

    await drive(harness, 'agent_end', {})
    await emit(harness, 'subagent:async-complete', { runId: 'run-1' })
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, 'subagent:async-complete', { runId: 'run-2' })
    expect(harness.states.at(-1)).toBe('done')

    // The final child woke the parent for another turn; the pane must not stay settled.
    await drive(harness, 'agent_start')
    expect(harness.states.at(-1)).toBe('working')
    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('done')

    expect(harness.states.filter((value) => value === 'done')).toHaveLength(2)
  })

  it('ignores a bus payload with no run id rather than inventing a child', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'go' })
    await drive(harness, 'agent_start')
    const before = harness.states.length

    await emit(harness, 'subagent:async-started', { note: 'no id here' })
    expect(harness.states).toHaveLength(before)

    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('done')
  })

  it('binds the process bus once across an in-process extension reload', () => {
    const harness = createHarness()
    expect(harness.processBusListenerCount('subagent:async-started')).toBe(1)
    harness.reload()
    // Why: pi replaces pi.on handlers on reload but not process-bus listeners; a second
    // registration would post every async child event twice.
    expect(harness.processBusListenerCount('subagent:async-started')).toBe(1)
  })

  it('does not register the pi subagent bus for omp or prime-agent', () => {
    expect(createHarness('omp').processBusListenerCount('subagent:async-started')).toBe(0)
    expect(createHarness('prime-agent').processBusListenerCount('subagent:async-started')).toBe(0)
  })
})
