import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { it, expect } from 'vitest'
import { useAppStore } from '@/store'
import { installSleepingRecordAccess } from './sleeping-record-access'
it('recordless pane fence reaches the materialization gate', () => {
  useAppStore.setState({
    sleepingAgentSessionsByPaneKey: {},
    legacyWorkerResumeFencesByPaneKey: { 'tab:leaf': true }
  })
  const session = {
    cacheKey: 'tab:leaf',
    deps: { tabId: 'tab', worktreeId: 'wt' },
    pane: { id: 1 }
  } as unknown as ConnectPanePtySession
  installSleepingRecordAccess(session)
  expect(session.isLegacyWorkerAutomaticResumeBlocked()).toBe(true)
})
