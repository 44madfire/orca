import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostTaskPreferenceOperations } from './web-host-task-preference-operations'

describe('web host task preference operations', () => {
  it('uses strict task updates and the existing opaque trust operation', async () => {
    const updateResume = vi.fn().mockResolvedValue(null)
    const updateSettings = vi.fn().mockResolvedValue(null)
    const sendRequest = vi.fn().mockResolvedValue({ ok: true, result: {} })
    const operations = webHostTaskPreferenceOperations({
      task: { updateResume, updateSettings },
      hostRpcSender: { sendRequest }
    } as unknown as MobileWebBridgeClient)

    await operations.updateResume({ githubMode: 'project' })
    await operations.updateSettings({ defaultTaskSource: 'linear' })
    await expect(
      operations.persistSetupTrust({
        trust: {},
        repoId: 'repo-1',
        contentHash: 'f'.repeat(64),
        alwaysTrust: true,
        approvedAt: 10
      })
    ).resolves.toEqual({
      'repo-1': { all: { approvedAt: 10 } }
    })

    expect(updateResume).toHaveBeenCalledWith({
      taskResumeState: { githubMode: 'project' }
    })
    expect(updateSettings).toHaveBeenCalledWith({ defaultTaskSource: 'linear' })
    expect(sendRequest).toHaveBeenCalledWith('ui.set', {
      trustedOrcaHooks: { 'repo-1': { all: { approvedAt: 10 } } }
    })
  })
})
