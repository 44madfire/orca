import { omitRecordKeys } from '@/store/slices/worktrees/teardown/record-key-omission'
import { useAppStore } from '@/store'
import { agentProviderSessionsEqual } from '../../../shared/agent-session-resume'

export function clearAutomaticAgentResumeClaim(tabId: string): void {
  useAppStore.setState((state) => ({
    automaticAgentResumeClaimsByTabId: omitRecordKeys(state.automaticAgentResumeClaimsByTabId, [
      tabId
    ])
  }))
}

export function settleAutomaticResumeSpawn(tabId: string, admitted: boolean): boolean {
  const state = useAppStore.getState()
  const claim = state.automaticAgentResumeClaimsByTabId?.[tabId]
  if (!claim) {
    return false
  }
  if (!admitted) {
    state.closeTab(tabId, {
      reason: 'cleanup',
      recordInteraction: false,
      captureRecentlyClosed: false,
      remoteCloseOwnedByHost: true,
      localPtyTeardownOwnedExternally: true
    })
    return true
  }
  clearAutomaticAgentResumeClaim(tabId)
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    if (
      record.worktreeId === claim.worktreeId &&
      record.agent === claim.launchAgent &&
      agentProviderSessionsEqual(record.agent, record.providerSession, claim.providerSession)
    ) {
      state.clearSleepingAgentSession(record.paneKey)
    }
  }
  return true
}
