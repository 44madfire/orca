export const SESSION_SEARCH_OPERATIONS = ['query', 'status', 'configure'] as const
export type SessionSearchOperation = (typeof SESSION_SEARCH_OPERATIONS)[number]

/**
 * One record per operation across the three method namespaces it travels.
 * They are not the same names — `configure` is `aiVault.searchConfigure` on the
 * relay and `aiVault.configureSessionSearch` on a runtime — so registering and
 * calling from here is what keeps a registered name and a called name in step.
 */
export const SESSION_SEARCH_METHODS = {
  query: {
    relay: 'aiVault.searchSessions',
    runtime: 'aiVault.searchSessions',
    runtimeSsh: 'aiVault.sshSearchSessions'
  },
  status: {
    relay: 'aiVault.searchIndexStatus',
    runtime: 'aiVault.searchIndexStatus',
    runtimeSsh: 'aiVault.sshSearchIndexStatus'
  },
  configure: {
    relay: 'aiVault.searchConfigure',
    runtime: 'aiVault.configureSessionSearch',
    runtimeSsh: 'aiVault.sshSearchConfigure'
  }
} as const satisfies Record<
  SessionSearchOperation,
  { relay: string; runtime: string; runtimeSsh: string }
>
