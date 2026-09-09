import { describe, expect, it } from 'vitest'
import { agentNeutralTerminalWaitBlockedReason } from './terminal-wait-blocked-reason-legacy-alias'
import type { RuntimeTerminalWaitBlockedReason } from './runtime-terminal-contracts'

describe('agentNeutralTerminalWaitBlockedReason', () => {
  it.each([
    ['codex-update-prompt', 'agent-update-prompt'],
    ['codex-trust-workspace', 'agent-trust-workspace'],
    ['codex-cwd-prompt', 'agent-cwd-prompt'],
    ['codex-interactive-prompt', 'agent-interactive-prompt']
  ] as const)('renames %s published by an older host to %s', (legacy, neutral) => {
    expect(agentNeutralTerminalWaitBlockedReason(legacy)).toBe(neutral)
  })

  // Why no alias: this build still publishes both, so aliasing them would rename a live reason rather
  // than reinterpret an older host's. ('codex just got an upgrade' names Codex; 'hooks need review'
  // does not, and stays Codex-labelled only because no neutral spelling was minted for it.)
  it.each(['codex-model-migration-prompt', 'codex-hooks-review-prompt'] as const)(
    'leaves the agent-specific %s alone',
    (reason) => {
      expect(agentNeutralTerminalWaitBlockedReason(reason)).toBeNull()
    }
  )

  it.each(['agent-approval-prompt', 'agent-trust-workspace'] as const)(
    'reports no alias for the already-neutral %s',
    (reason) => {
      expect(agentNeutralTerminalWaitBlockedReason(reason)).toBeNull()
    }
  )

  // Why: the reason is JSON off the wire with no enum to validate it, and an object-literal lookup
  // would answer these from Object.prototype -- the CLI would then print a function to the user.
  it.each(['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'])(
    'reports no alias for the prototype key %s',
    (reason) => {
      expect(
        agentNeutralTerminalWaitBlockedReason(reason as RuntimeTerminalWaitBlockedReason)
      ).toBeNull()
    }
  )
})
