/** Placeholder tab label for a structured chat that has no conversation name yet. */
export function defaultAgentChatLabel(agent: 'claude' | 'codex' | null | undefined): string {
  return agent === 'claude' ? 'Claude Chat' : 'Codex Chat'
}
