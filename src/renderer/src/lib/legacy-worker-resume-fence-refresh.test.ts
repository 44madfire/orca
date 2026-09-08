import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { refreshLegacyWorkerResumeFences } from './legacy-worker-resume-fence-refresh'

const PANE_KEY = 'tab-1:11111111-2222-4333-8444-555555555555'

function stubFences(...replies: (Record<string, true> | undefined)[]): ReturnType<typeof vi.fn> {
  const get = vi.fn()
  for (const reply of replies) {
    get.mockResolvedValueOnce(reply)
  }
  get.mockResolvedValue(replies.at(-1))
  vi.stubGlobal('window', {
    ...globalThis.window,
    api: { app: { getLegacyWorkerResumeFences: get } }
  })
  return get
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState({ legacyWorkerResumeFencesByPaneKey: {} })
})

describe('re-reading the fenced-pane set after main invalidates it', () => {
  it('installs the set main reports', async () => {
    stubFences({ [PANE_KEY]: true })

    await refreshLegacyWorkerResumeFences()

    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [PANE_KEY]: true })
  })

  it('replaces the set rather than merging, so a retired pane is dropped', async () => {
    useAppStore.setState({ legacyWorkerResumeFencesByPaneKey: { [PANE_KEY]: true } })
    stubFences({})

    await refreshLegacyWorkerResumeFences()

    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({})
  })

  it('keeps the previous set when the read fails', async () => {
    useAppStore.setState({ legacyWorkerResumeFencesByPaneKey: { [PANE_KEY]: true } })
    const get = vi.fn().mockRejectedValue(new Error('runtime_unavailable'))
    vi.stubGlobal('window', {
      ...globalThis.window,
      api: { app: { getLegacyWorkerResumeFences: get } }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await refreshLegacyWorkerResumeFences()
    } finally {
      warn.mockRestore()
    }

    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [PANE_KEY]: true })
  })
})
