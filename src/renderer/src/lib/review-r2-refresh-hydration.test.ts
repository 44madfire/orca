import { it, expect, vi, afterEach } from 'vitest'
import { useAppStore } from '@/store'
import { refreshLegacyWorkerResumeFences } from './legacy-worker-resume-fence-refresh'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState({ legacyWorkerResumeFencesByPaneKey: {} })
})
it('startup hydration cannot roll back a newer ping read', async () => {
  const oldSession = getDefaultWorkspaceSession()
  vi.stubGlobal('window', {
    api: { app: { getLegacyWorkerResumeFences: vi.fn().mockResolvedValue({ 'tab:leaf': true }) } }
  })
  await refreshLegacyWorkerResumeFences()
  expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey['tab:leaf']).toBe(true)
  useAppStore.getState().hydrateWorkspaceSession(oldSession)
  expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey['tab:leaf']).toBe(true)
})
it('a pending read cannot overwrite newer hydration', async () => {
  let resolve!: (v: Record<string, true>) => void
  vi.stubGlobal('window', {
    api: {
      app: {
        getLegacyWorkerResumeFences: () =>
          new Promise((r) => {
            resolve = r
          })
      }
    }
  })
  const read = refreshLegacyWorkerResumeFences()
  useAppStore.getState().hydrateWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    legacyWorkerResumeFencesByPaneKey: { 'tab:leaf': true }
  })
  resolve({})
  await read
  expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey['tab:leaf']).toBe(true)
})
