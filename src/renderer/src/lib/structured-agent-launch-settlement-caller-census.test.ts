import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { glob } from 'tinyglobby'

const REPO_ROOT = join(import.meta.dirname, '../../../..')
const CENSUS_FILE = 'src/renderer/src/lib/structured-agent-launch-settlement-caller-census.test.ts'
const LOOP_FILE = 'src/renderer/src/lib/structured-agent-launch-settlement.ts'

// Why: every structured entrypoint consumes the one settle loop and decides its route before
// calling it. A new caller is a new entrypoint and must be reviewed for route, cancellation,
// fallback, and draft-seed handling before it lands here.
const SETTLE_LOOP_CALLERS = [
  'src/renderer/src/components/right-sidebar/ai-vault-session-resume-in-chat-launch.ts',
  'src/renderer/src/components/sidebar/folder-workspace-composer-submit.ts',
  'src/renderer/src/hooks/composer-state/full-creation-structured-launch.ts',
  'src/renderer/src/lib/launch-agent-in-new-tab-structured.ts',
  'src/renderer/src/lib/launch-work-item-direct-agent-routing.ts',
  'src/renderer/src/lib/onboarding-folder-agent-launch.ts',
  'src/renderer/src/lib/worktree-creation-structured-session.ts'
]

describe('structured launch settle loop caller census', () => {
  it('pins every production settleStructuredAgentLaunch caller', async () => {
    const files = await glob(['src/**/*.ts', 'src/**/*.tsx'], {
      cwd: REPO_ROOT,
      ignore: ['**/*.test.ts', '**/*.test.tsx', CENSUS_FILE, LOOP_FILE]
    })
    const callers = files
      .filter((file) =>
        readFileSync(join(REPO_ROOT, file), 'utf8').includes('settleStructuredAgentLaunch(')
      )
      .sort()
    expect(callers).toEqual([...SETTLE_LOOP_CALLERS].sort())
  })
})
