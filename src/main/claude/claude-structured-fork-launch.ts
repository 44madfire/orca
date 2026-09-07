import type { AgentSessionForkTarget } from '../../shared/agent-session-fork'
import {
  claudeSessionIdForOrcaSession,
  type ClaudeStructuredLaunch
} from './claude-structured-launch-resolution'

export function applyClaudeStructuredForkLaunch(
  launch: ClaudeStructuredLaunch,
  fork: AgentSessionForkTarget,
  sessionId: string
): ClaudeStructuredLaunch {
  if (
    fork.source.provider !== 'claude' ||
    (launch.resumed && launch.providerSessionId !== fork.source.sessionId)
  ) {
    throw new Error('agent_session_identity_required')
  }
  const providerSessionId = claudeSessionIdForOrcaSession(sessionId)
  if (providerSessionId === fork.source.sessionId) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  return {
    ...launch,
    providerSessionId,
    resumeLeafUuid: fork.throughId,
    resumed: false,
    options: {
      ...launch.options,
      resume: fork.source.sessionId,
      resumeSessionAt: fork.throughId,
      forkSession: true,
      sessionId: providerSessionId
    }
  }
}
