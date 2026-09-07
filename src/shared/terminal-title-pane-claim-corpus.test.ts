import { describe, expect, it } from 'vitest'
import { TERMINAL_TITLE_CLASSIFICATION_CORPUS } from './terminal-title-classification-corpus'
import {
  isClaudeIdentityFrameTitle,
  resolveExplicitTerminalTitleAgentType
} from './terminal-title-agent-type'
import { titlePresentsAgent } from './agent-title-evidence'

/**
 * The ratchet that enforces agreement between the gate and the resolver that feeds it.
 *
 * `titlePresentsAgent` and `getAgentLabel` are different models on purpose — the gate needs to
 * know WHERE a name sits and the resolver discards that. Agreement therefore cannot be enforced
 * by sharing code, so it is enforced here instead: for every corpus title the resolver mints an
 * identity from, the gate must still let that identity claim a pane.
 *
 * This exists because two rounds of review found the same class of defect. A predicate that was
 * correct about its own evidence model silently stopped four whole routes — Pi's native titles,
 * name-plus-status forms, "|"-headed titles and Windows launcher forms — from ever claiming a
 * pane, and no test failed. Add a route to `getAgentLabel` that the gate cannot read and this
 * goes red, naming the title.
 */

/** The pre-change gate: any non-Claude title claimed, Claude needed an identity frame (#8940). */
function claimedBeforeThisChange(title: string, agent: string): boolean {
  return agent !== 'claude' || isClaudeIdentityFrameTitle(title)
}

/**
 * Titles the gate now accepts that the old one refused. Symmetry, not drift: the old gate accepted
 * `aider.ps1 ready` for aider and refused the identical Windows-launcher-plus-status-word form for
 * Claude, purely because the guard was Claude-only. Making the grammar agent-neutral necessarily
 * makes Claude symmetric with every other agent; keeping the carve-out would preserve a Claude
 * exception inside the change whose whole purpose is removing Claude exceptions.
 */
const INTENDED_NEW_CLAIMS: readonly string[] = ['claude.bat working']

describe('terminal title pane-claim corpus', () => {
  it('never loses a pane claim the resolver still mints', () => {
    const lost: string[] = []
    for (const title of TERMINAL_TITLE_CLASSIFICATION_CORPUS) {
      const agent = resolveExplicitTerminalTitleAgentType(title)
      if (!agent) {
        continue
      }
      if (claimedBeforeThisChange(title, agent) && !titlePresentsAgent(title, agent)) {
        lost.push(`${JSON.stringify(title)} -> ${agent}`)
      }
    }
    expect(lost).toEqual([])
  })

  it('gains only the claims listed as intended', () => {
    const gained: string[] = []
    for (const title of TERMINAL_TITLE_CLASSIFICATION_CORPUS) {
      const agent = resolveExplicitTerminalTitleAgentType(title)
      if (!agent) {
        continue
      }
      if (!claimedBeforeThisChange(title, agent) && titlePresentsAgent(title, agent)) {
        gained.push(title)
      }
    }
    expect(gained).toEqual([...INTENDED_NEW_CLAIMS])
  })

  // The forgeable route, which is the only one the gate exists to stop. A name in the middle of a
  // sentence is a mention; #8940's direction and #14937's direction are the same rule.
  it('still refuses a name that only appears inside task text', () => {
    const mustReject: [string, Parameters<typeof titlePresentsAgent>[1]][] = [
      ['⠋ Fix the codex plugin launcher', 'codex'],
      ['⠙ Investigate why codex hangs on Windows', 'codex'],
      ['⠹ compare codex and claude output', 'codex'],
      ['⠋ add grok support to the tab bar', 'grok'],
      ['⠋ port the gemini status parser', 'gemini'],
      ['⠋ review copilot suggestions', 'copilot'],
      ['⠋ refactor the aider bridge', 'aider'],
      ['⠋ Codex plugin launcher rewrite', 'codex'],
      ['. port the claude prompt', 'claude'],
      ['. ship it with claude', 'claude'],
      ['. Claude Code compare Opencode', 'claude'],
      ['⠋ use Claude Sonnet', 'claude'],
      ['OC | ⠋ ask claude about this', 'claude'],
      ['. Compare Opencode Vs Orca', 'claude'],
      ['✳ investigating startup', 'claude']
    ]
    expect(mustReject.filter(([title, agent]) => titlePresentsAgent(title, agent))).toEqual([])
  })

  // The routes round 2 lost. Named individually so a regression says which grammar broke.
  it('accepts every route the resolver mints identity from', () => {
    const routes: [string, Parameters<typeof titlePresentsAgent>[1]][] = [
      ['π > session - ~/orca', 'pi'],
      ['π ! blocked-session', 'pi'],
      ['⠋ π - session - ~/orca', 'pi'],
      ['codex working', 'codex'],
      ['grok done', 'grok'],
      ['devin thinking', 'devin'],
      ['mimo idle', 'mimo-code'],
      ['aider running', 'aider'],
      ['copilot waiting', 'copilot'],
      ['opencode ready', 'opencode'],
      ['ssh host | opencode ready', 'opencode'],
      ['⠉ Codex — refactoring', 'codex'],
      ['aider.ps1 ready', 'aider'],
      ['copilot.exe - action required', 'copilot'],
      ['✦ Analyzing the repository', 'gemini'],
      ['cursor agent', 'cursor'],
      ['⠋ Codex', 'codex'],
      ['⠋ Codex: fix cursor offsets', 'codex'],
      ['⠋ Claude Code', 'claude']
    ]
    expect(routes.filter(([title, agent]) => !titlePresentsAgent(title, agent))).toEqual([])
  })
})
