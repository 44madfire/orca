import type { AgentSessionExecutionLocation } from './agent-session-record'

/** NUL cannot occur in a host id, distro name, or workspace id, so no component can forge a join. */
const SCOPE_KEY_SEPARATOR = '\u0000'

/**
 * Scope key for host-and-workspace isolation. Native, WSL, and SSH copies of one workspace id are
 * different sessions; collapsing them would let one host adjudicate another host's lease.
 */
export function agentSessionScopeKey(location: AgentSessionExecutionLocation): string {
  return [location.executionHostId, location.wslDistro ?? '', location.workspaceId].join(
    SCOPE_KEY_SEPARATOR
  )
}

export function agentSessionExecutionLocationsEqual(
  left: AgentSessionExecutionLocation,
  right: AgentSessionExecutionLocation
): boolean {
  return (
    agentSessionScopeKey(left) === agentSessionScopeKey(right) &&
    left.workspaceKind === right.workspaceKind
  )
}
