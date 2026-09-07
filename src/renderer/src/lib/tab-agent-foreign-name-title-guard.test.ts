import { describe, expect, it } from 'vitest'
import { resolveTabAgentFromSignals as resolveFromSignalsModule } from './tab-agent-from-signals'
import { resolveTabAgentFromSignals as resolveFromHookModule } from './use-tab-agent'

/**
 * #14937: a Claude pane's WORKING title is a bare braille spinner plus task text, so any agent
 * name in that text used to resolve the title to a committed foreign identity and take the pane
 * from its Claude owner. The guard that fixed the mirror-image bug (#8940) was written for the
 * Claude label only, so every other name short-circuited above it.
 *
 * Both copies are exercised on purpose: `useTabAgent` (the tab-bar icon) calls the copy in
 * use-tab-agent.ts, while open-tab-occupant-agent.ts and the rest of these suites call the copy in
 * tab-agent-from-signals.ts. They are separate implementations of the same contract.
 */
const RESOLVERS = [
  ['tab-agent-from-signals', resolveFromSignalsModule],
  ['use-tab-agent', resolveFromHookModule]
] as const

const FOREIGN_NAME_TASK_TITLES = [
  '⠋ Fix the codex plugin launcher',
  '⠙ Investigate why codex hangs on Windows',
  '⠹ compare codex and claude output',
  '⠋ add grok support to the tab bar',
  '⠋ port the gemini status parser',
  '⠋ review copilot suggestions'
]

describe.each(RESOLVERS)('%s: a foreign name in task text is a mention', (_name, resolve) => {
  it('keeps a Claude-owned pane Claude with no live hook', () => {
    for (const title of FOREIGN_NAME_TASK_TITLES) {
      expect(
        resolve({
          hasObservedAgentSignal: true,
          isRemote: false,
          title,
          hookAgent: null,
          launchAgent: 'claude'
        })
      ).toBe('claude')
    }
  })

  it('keeps a Claude-owned pane Claude with a completed hook, and on a remote pane', () => {
    const title = '⠋ Fix the codex plugin launcher'
    expect(
      resolve({
        hasObservedAgentSignal: true,
        isRemote: false,
        title,
        hookAgent: null,
        focusedCompletedHookAgent: 'claude',
        launchAgent: 'claude'
      })
    ).toBe('claude')
    expect(
      resolve({
        hasObservedAgentSignal: true,
        isRemote: true,
        title,
        hookAgent: null,
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  // Non-discriminating on its own — it passes before the fix too. Kept as the control that shows
  // why users experienced this as random: a live hook always outranked the title.
  it('was already correct while a live hook existed', () => {
    expect(
      resolve({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠋ Fix the codex plugin launcher',
        hookAgent: 'claude',
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  // The guard must stay agent-neutral in BOTH directions. This is the assertion that fails if
  // someone reintroduces a one-way guard: #8940's direction and #14937's direction are one rule.
  it('still lets a genuine identity frame reclaim a reused pane, both directions', () => {
    expect(
      resolve({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        launchAgent: 'opencode'
      })
    ).toBe('claude')
    expect(
      resolve({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠋ Codex',
        hookAgent: null,
        launchAgent: 'claude'
      })
    ).toBe('codex')
  })

  it('keeps an OpenCode pane OpenCode when its task text mentions Claude (#8940)', () => {
    for (const title of [
      'OC | ⠋ ask claude about this',
      '⠋ use Claude Sonnet',
      '⠋ port the claude prompt'
    ]) {
      expect(
        resolve({
          hasObservedAgentSignal: true,
          isRemote: false,
          title,
          hookAgent: null,
          launchAgent: 'opencode'
        })
      ).toBe('opencode')
    }
  })
})
