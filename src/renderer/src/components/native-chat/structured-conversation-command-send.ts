import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'

export async function sendStructuredConversationCommand(input: {
  command: AgentSessionConversationCommand
  pending: { current: boolean }
  blocked: boolean
  send: (
    command: AgentSessionConversationCommand
  ) => Promise<AgentSessionConversationCommandResult | null>
}): Promise<{ accepted: boolean; error: string | null }> {
  if (input.pending.current || input.blocked) {
    return {
      accepted: false,
      error: 'Wait for pending work and messages to finish before using this command.'
    }
  }
  input.pending.current = true
  try {
    const result = await input.send(input.command)
    return {
      accepted: result?.state === 'completed' && !result.error,
      error: result?.error ?? (result ? null : 'Conversation operation was not confirmed.')
    }
  } finally {
    input.pending.current = false
  }
}
