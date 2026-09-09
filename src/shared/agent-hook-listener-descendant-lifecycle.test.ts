import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'
import type { AgentHookSource } from './agent-hook-relay'

/** Every case drives `normalizeHookPayload`, the entry both the main process and the relay
 *  call, so a fix that never reaches production wiring cannot pass here. */
describe('descendant lifecycle never settles the pane', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  const publish = (
    source: AgentHookSource,
    payload: Record<string, unknown>
  ): ReturnType<typeof normalizeAndAccept> => normalizeAndAccept(state, source, payload)

  const publishedState = (
    source: AgentHookSource,
    payload: Record<string, unknown>
  ): string | undefined => publish(source, payload)?.payload.state

  describe('grok nested subagents (STA-6982)', () => {
    const startTurn = (): void => {
      expect(publishedState('grok', { hookEventName: 'UserPromptSubmit', prompt: 'ship it' })).toBe(
        'working'
      )
    }

    it('keeps the pane working when a nested child session ends', () => {
      startTurn()
      // Why: grok remaps a child's turn gate to SubagentStop, so the child's own SessionEnd is what
      // reaches the parent's pane. It carries subagentType; the session's own SessionEnd never does.
      expect(
        publishedState('grok', {
          hookEventName: 'SessionEnd',
          reason: 'clear',
          subagentType: 'explore'
        })
      ).toBe('working')
    })

    it('keeps the pane working when a nested child turn fails', () => {
      startTurn()
      expect(
        publishedState('grok', {
          hookEventName: 'StopFailure',
          error: 'rate_limit',
          subagentType: 'explore'
        })
      ).toBe('working')
    })

    it('still settles the pane on the lead session own stop', () => {
      startTurn()
      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('done')
    })

    it('holds the pane working while a tracked child outlives the lead turn', () => {
      startTurn()
      const spawned = publish('grok', {
        hookEventName: 'SubagentStart',
        subagentId: 'sub-1',
        subagentType: 'explore',
        description: 'review the diff'
      })
      expect(spawned?.payload.state).toBe('working')
      expect(spawned?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'sub-1', state: 'working', agentType: 'explore' })
      ])

      // The lead's own Stop is real, but a live child means the pane is not idle yet.
      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('working')

      const drained = publish('grok', {
        hookEventName: 'SubagentStop',
        subagentId: 'sub-1',
        subagentType: 'explore'
      })
      expect(drained?.payload.state).toBe('done')
      expect(drained?.payload.subagents).toBeUndefined()
    })

    it('publishes exactly one done across a child-then-lead completion', () => {
      startTurn()
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })
      const states = [
        publishedState('grok', { hookEventName: 'SessionEnd', reason: 'clear', subagentType: 'x' }),
        publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' }),
        publishedState('grok', {
          hookEventName: 'SubagentStop',
          subagentId: 'sub-1',
          subagentType: 'x'
        })
      ]
      expect(states).toEqual(['working', 'working', 'done'])
      expect(states.filter((value) => value === 'done')).toHaveLength(1)
    })

    it('does not relabel the pane with a child tool call', () => {
      startTurn()
      const parentTool = publish('grok', {
        hookEventName: 'PreToolUse',
        toolName: 'edit_file',
        toolInput: { path: 'src/app.ts' }
      })
      expect(parentTool?.payload.toolName).toBe('edit_file')

      const childTool = publish('grok', {
        hookEventName: 'PreToolUse',
        subagentType: 'explore',
        subagentId: 'sub-1',
        toolName: 'run_terminal_cmd',
        toolInput: { command: 'rg TODO' }
      })
      expect(childTool?.payload.state).toBe('working')
      expect(childTool?.payload.toolName).toBe('edit_file')
      expect(childTool?.payload.prompt).toBe('ship it')
      expect(childTool?.hasExplicitPrompt).toBeUndefined()
    })

    it('drops a stale child roster when the pane starts a new agent process', () => {
      startTurn()
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })
      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('working')

      // Why: a child whose stop hook was lost must not pin the pane forever; a replaced agent
      // process cannot still have the old process's children.
      publish('grok', { hookEventName: 'SessionStart', source: 'startup' })
      expect(publishedState('grok', { hookEventName: 'UserPromptSubmit', prompt: 'again' })).toBe(
        'working'
      )
      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('done')
    })
  })

  describe('pi async subagent runs (STA-6378)', () => {
    const startTurn = (): void => {
      expect(
        publishedState('pi', { hook_event_name: 'before_agent_start', prompt: 'delegate' })
      ).toBe('working')
      expect(publishedState('pi', { hook_event_name: 'agent_start' })).toBe('working')
    }

    it('settles the pane when the parent ends with no async children', () => {
      startTurn()
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('done')
    })

    it('stays working when the parent settles while an async child run continues', () => {
      startTurn()
      const started = publish('pi', {
        hook_event_name: 'subagent_async_started',
        subagent_id: 'run-1',
        agent_type: 'researcher'
      })
      expect(started?.payload.state).toBe('working')
      expect(started?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'run-1', state: 'working', agentType: 'researcher' })
      ])

      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('working')

      const finished = publish('pi', {
        hook_event_name: 'subagent_async_complete',
        subagent_id: 'run-1'
      })
      expect(finished?.payload.state).toBe('done')
      expect(finished?.payload.subagents).toBeUndefined()
    })

    it('completes once when the final child wakes the parent for another turn', () => {
      startTurn()
      publish('pi', { hook_event_name: 'subagent_async_started', subagent_id: 'run-1' })
      publish('pi', { hook_event_name: 'subagent_async_started', subagent_id: 'run-2' })

      const states = [
        publishedState('pi', { hook_event_name: 'agent_end' }),
        publishedState('pi', { hook_event_name: 'subagent_async_complete', subagent_id: 'run-1' }),
        // The last child wakes the parent, which runs another turn before the pane is idle.
        publishedState('pi', { hook_event_name: 'subagent_async_complete', subagent_id: 'run-2' }),
        publishedState('pi', { hook_event_name: 'agent_start' }),
        publishedState('pi', { hook_event_name: 'agent_end' })
      ]
      expect(states).toEqual(['working', 'working', 'done', 'working', 'done'])
    })

    it('keeps the parent prompt while an async child reports', () => {
      startTurn()
      const started = publish('pi', {
        hook_event_name: 'subagent_async_started',
        subagent_id: 'run-1',
        prompt: 'child task text'
      })
      expect(started?.payload.prompt).toBe('delegate')
      expect(started?.hasExplicitPrompt).toBeUndefined()
    })
  })

  describe('pane-scoped state bookkeeping', () => {
    it('reports a descendant-only pane as holding a state claim', async () => {
      const { paneHasStateClaims, clearPaneCacheState } =
        await import('./agent-hook-listener/listener-state')
      publish('grok', { hookEventName: 'UserPromptSubmit', prompt: 'go' })
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })
      expect(paneHasStateClaims(state, PANE_KEY)).toBe(true)

      clearPaneCacheState(state, PANE_KEY)
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
      expect(state.descendantLeadStateByPaneKey.has(PANE_KEY)).toBe(false)
    })

    it('moves descendant state with the pane when its key is remapped', async () => {
      const { movePaneCacheState } = await import('./agent-hook-listener/listener-state')
      publish('grok', { hookEventName: 'UserPromptSubmit', prompt: 'go' })
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })

      movePaneCacheState(state, PANE_KEY, 'tab-2:22222222-2222-4222-8222-222222222222')
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
      expect(
        state.descendantRosterByPaneKey.get('tab-2:22222222-2222-4222-8222-222222222222')?.size
      ).toBe(1)
    })
  })
})
