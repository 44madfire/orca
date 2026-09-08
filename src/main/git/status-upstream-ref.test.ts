import { describe, expect, it, vi } from 'vitest'
import { resolveGitStatusUpstreamRef } from './status-upstream-ref'

const signal = (): AbortSignal => new AbortController().signal

describe('resolveGitStatusUpstreamRef', () => {
  it.each(['refs/remotes/team/fork/feature', 'refs/custom/feature', 'refs/heads/feature/base'])(
    'retains the full configured ref %s for old status publishers',
    async (ref) => {
      const exec = vi.fn().mockResolvedValue({ stdout: `refs/heads/feature\0${ref}\n` })
      const label = ref.replace(/^refs\/(remotes|heads)\//, '')
      expect(
        await resolveGitStatusUpstreamRef(exec, '/repo', 'refs/heads/feature', label, signal())
      ).toBe(ref)
      expect(exec).toHaveBeenCalledOnce()
    }
  )
  it('uses canonical metadata for an explicit publish target independently of its label', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: 'refs/heads/feature\0refs/remotes/origin/main\n' })
    expect(
      await resolveGitStatusUpstreamRef(
        exec,
        '/repo',
        'refs/heads/feature',
        'unrelated/display',
        signal(),
        'refs/custom/fork/feature'
      )
    ).toBe('refs/custom/fork/feature')
    expect(exec).toHaveBeenCalledOnce()
  })
  it('resolves an old publisher legacy override through shared host policy', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'refs/heads/feature\0refs/remotes/origin/main\n' })
      .mockResolvedValueOnce({
        stdout: 'refs/remotes/origin/main\0=\0refs/heads/feature\0origin\0refs/heads/main\n'
      })
      .mockResolvedValueOnce({ stdout: 'oid' })
    expect(
      await resolveGitStatusUpstreamRef(
        exec,
        '/repo',
        'refs/heads/feature',
        'origin/feature',
        signal()
      )
    ).toBe('refs/remotes/origin/feature')
    expect(exec.mock.calls.flat(2)).not.toContain('origin/feature')
  })
  it('rejects a stale branch and unsafe metadata without interpreting labels', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'refs/heads/feature\0refs/remotes/origin/main\n' })
    expect(
      await resolveGitStatusUpstreamRef(
        exec,
        '/repo',
        'refs/heads/old',
        'origin/old',
        signal(),
        'refs/remotes/origin/old'
      )
    ).toBeUndefined()
    expect(
      await resolveGitStatusUpstreamRef(
        exec,
        '/repo',
        'refs/heads/feature',
        'origin/main',
        signal(),
        'refs/../bad'
      )
    ).toBeUndefined()
  })
})
