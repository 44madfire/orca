import { describe, expect, it } from 'vitest'
import { applyClaudeStructuredForkLaunch } from './claude-structured-fork-launch'
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'

const launch: ClaudeStructuredLaunch = {
  pathToClaudeCodeExecutable: 'claude',
  options: { resume: 'parent', model: 'model' },
  cwd: '/workspace',
  claudeConfigDir: '/account',
  providerSessionId: 'parent',
  resumeLeafUuid: 'latest',
  resumed: true
}

describe('Claude structured fork launch', () => {
  it('combines forkSession with the selected UUID and a distinct child session identity', () => {
    const forked = applyClaudeStructuredForkLaunch(
      launch,
      {
        source: { provider: 'claude', sessionId: 'parent', leafUuid: 'latest' },
        throughId: 'selected'
      },
      'claude_new_session'
    )
    expect(forked.options).toMatchObject({
      forkSession: true,
      resume: 'parent',
      resumeSessionAt: 'selected',
      sessionId: forked.providerSessionId,
      model: 'model'
    })
    expect(forked.providerSessionId).not.toBe('parent')
    expect(forked.resumeLeafUuid).toBe('selected')
    expect(forked.resumed).toBe(false)
    expect(launch.options).not.toHaveProperty('forkSession')
  })

  it('refuses a source different from the account-pinned launch', () => {
    expect(() =>
      applyClaudeStructuredForkLaunch(
        launch,
        {
          source: { provider: 'claude', sessionId: 'foreign', leafUuid: null },
          throughId: 'selected'
        },
        'claude_new_session'
      )
    ).toThrow('agent_session_identity_required')
  })
})
